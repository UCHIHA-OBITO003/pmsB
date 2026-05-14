import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { authenticate, requirePermission, requireRole, AuthRequest } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import {
  applyCodemagenTicketVisibility,
  filterVisibleMembershipUsers,
  filterVisibleUsers,
  getCodemagenEnabled,
} from '../utils/system-settings';
import { emitBoardEvent } from '../services/board-events.service';
import { enqueueGitHubProjectSync } from '../queues';
import {
  deleteProjectGitHubLink,
  getProjectGitHubActivity,
  getProjectGitHubMembers,
  getProjectGitHubOverview,
  saveProjectGitHubLink,
  updateProjectGitHubBoard,
} from '../services/github.service';

const router = Router();
router.use(authenticate);

const ProjectSchema = z.object({
  name: z.string().min(1).max(100),
  key: z.string().min(2).max(10).toUpperCase(),
  description: z.string().optional(),
  companyId: z.string().uuid().optional().nullable(),
  teamId: z.string().uuid().optional().nullable(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  budget: z.number().optional(),
  status: z.enum(['ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED', 'PLANNING']).optional(),
});

async function countVisibleTickets(projectId: string, codemagenEnabled: boolean): Promise<number> {
  const where: Prisma.TicketWhereInput = { projectId, deletedAt: null };
  applyCodemagenTicketVisibility(where, codemagenEnabled);
  return prisma.ticket.count({ where });
}

// GET /api/projects
router.get('/', requirePermission('projects', 'read'), async (req: AuthRequest, res) => {
  const { search, status, page = '1', limit = '20' } = req.query as Record<string, string>;
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const codemagenEnabled = await getCodemagenEnabled();

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

  const visibleTicketCounts = await Promise.all(projects.map((project) => countVisibleTickets(project.id, codemagenEnabled)));

  res.json({
    success: true,
    data: {
      projects: projects.map((project, index) => ({
        ...project,
        _count: {
          ...project._count,
          tickets: visibleTicketCounts[index],
        },
      })),
      total,
      page: parseInt(page),
      limit: parseInt(limit),
    },
  });
});

// GET /api/projects/:id
router.get('/:id', requirePermission('projects', 'read'), async (req, res) => {
  const codemagenEnabled = await getCodemagenEnabled();
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, deletedAt: null },
    include: {
      company: { select: { id: true, name: true, organisationId: true } },
      members: {
        include: {
          user: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              avatar: true,
              status: true,
              skills: true,
              department: true,
            },
          },
        },
      },
      sprints: { where: { status: 'ACTIVE' }, take: 1 },
      _count: { select: { tickets: true, sprints: true, members: true } },
      workflowStates: { orderBy: { order: 'asc' } },
      githubLinks: {
        orderBy: { createdAt: 'asc' },
        include: {
          installation: {
            select: { id: true, accountLogin: true, accountType: true, githubInstallationId: true },
          },
        },
      },
      githubBoardInstallation: {
        select: { id: true, accountLogin: true, accountType: true, githubInstallationId: true },
      },
    },
  });

  if (!project) throw new AppError(404, 'Project not found', 'NOT_FOUND');
  const visibleTicketCount = await countVisibleTickets(project.id, codemagenEnabled);
  res.json({
    success: true,
    data: {
      ...project,
      _count: {
        ...project._count,
        tickets: visibleTicketCount,
      },
      members: filterVisibleMembershipUsers(project.members, codemagenEnabled),
    },
  });
});

const ProjectGitHubLinkSchema = z.object({
  installationId: z.string().uuid(),
  ownerLogin: z.string().min(1),
  ownerType: z.enum(['USER', 'ORGANIZATION']).optional(),
  repositoryId: z.string().min(1),
  repositoryNodeId: z.string().optional().nullable(),
  repositoryName: z.string().min(1),
  repositoryFullName: z.string().min(1),
  defaultBranch: z.string().optional().nullable(),
});

const ProjectGitHubBoardSchema = z.object({
  installationId: z.string().uuid().optional().nullable(),
  ownerLogin: z.string().min(1).optional().nullable(),
  ownerType: z.enum(['USER', 'ORGANIZATION']).optional().nullable(),
  githubProjectId: z.string().optional().nullable(),
  githubProjectNumber: z.number().int().optional().nullable(),
  githubProjectTitle: z.string().optional().nullable(),
});

const ProjectGitHubSyncSchema = z.object({
  forceFull: z.boolean().optional(),
  linkId: z.string().uuid().optional(),
  lookbackDays: z.number().int().min(1).max(365).optional(),
});

router.get('/:id/github', requirePermission('projects', 'read'), async (req, res) => {
  const data = await getProjectGitHubOverview(req.params.id);
  res.json({ success: true, data });
});

router.get('/:id/github/activity', requirePermission('projects', 'read'), async (req, res) => {
  const { limit = '40' } = req.query as { limit?: string };
  const data = await getProjectGitHubActivity(req.params.id, Math.min(parseInt(limit) || 40, 200));
  res.json({ success: true, data });
});

router.get('/:id/github/members', requirePermission('projects', 'read'), async (req, res) => {
  const data = await getProjectGitHubMembers(req.params.id);
  res.json({ success: true, data });
});

router.post('/:id/github/link', requirePermission('projects', 'update'), async (req: AuthRequest, res) => {
  const body = ProjectGitHubLinkSchema.parse(req.body ?? {});
  const data = await saveProjectGitHubLink({
    projectId: req.params.id,
    installationId: body.installationId,
    ownerLogin: body.ownerLogin,
    ownerType: body.ownerType,
    repositoryId: body.repositoryId,
    repositoryNodeId: body.repositoryNodeId ?? null,
    repositoryName: body.repositoryName,
    repositoryFullName: body.repositoryFullName,
    defaultBranch: body.defaultBranch ?? null,
    createdBy: req.user?.id,
  });

  await enqueueGitHubProjectSync({
    type: 'sync-project-link',
    projectGitHubLinkId: data.id,
    requestedBy: req.user?.id,
    forceFull: true,
  });

  res.status(201).json({ success: true, data });
});

router.patch('/:id/github/board', requirePermission('projects', 'update'), async (req, res) => {
  const body = ProjectGitHubBoardSchema.parse(req.body ?? {});
  const data = await updateProjectGitHubBoard({
    projectId: req.params.id,
    installationId: body.installationId ?? null,
    ownerLogin: body.ownerLogin ?? null,
    ownerType: body.ownerType ?? null,
    githubProjectId: body.githubProjectId ?? null,
    githubProjectNumber: body.githubProjectNumber ?? null,
    githubProjectTitle: body.githubProjectTitle ?? null,
  });
  res.json({ success: true, data });
});

router.post('/:id/github/sync', requirePermission('projects', 'update'), async (req: AuthRequest, res) => {
  const body = ProjectGitHubSyncSchema.parse(req.body ?? {});
  const links =
    body.linkId ?
      await prisma.projectGitHubLink.findMany({
        where: { id: body.linkId, projectId: req.params.id },
        select: { id: true },
      })
    : await prisma.projectGitHubLink.findMany({
        where: { projectId: req.params.id },
        select: { id: true },
      });
  if (links.length === 0) throw new AppError(404, 'GitHub link not found for this project', 'GITHUB_LINK_NOT_FOUND');

  await Promise.all(
    links.map((link) =>
      enqueueGitHubProjectSync({
        type: 'sync-project-link',
        projectGitHubLinkId: link.id,
        requestedBy: req.user?.id,
        forceFull: body.forceFull === true,
        lookbackDays: body.lookbackDays,
      }),
    ),
  );

  res.json({
    success: true,
    message: links.length === 1 ? 'GitHub sync queued' : `GitHub sync queued for ${links.length} repositories`,
  });
});

router.delete('/:id/github/link/:linkId', requirePermission('projects', 'update'), async (req, res) => {
  await deleteProjectGitHubLink(req.params.id, req.params.linkId);
  res.json({ success: true, message: 'GitHub link removed' });
});

// GET /api/projects/:id/roster-summary — company, org, team, members, ticket counts by source
router.get('/:id/roster-summary', requirePermission('projects', 'read'), async (req, res) => {
  const codemagenEnabled = await getCodemagenEnabled();
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, deletedAt: null },
    include: {
      company: { include: { organisation: { select: { id: true, name: true } } } },
      team: {
        select: {
          id: true,
          name: true,
          members: { select: { userId: true, role: true } },
        },
      },
      members: {
        include: {
          user: { select: { id: true, firstName: true, lastName: true, email: true, status: true, department: true } },
        },
      },
    },
  });
  if (!project) throw new AppError(404, 'Project not found', 'NOT_FOUND');

  const teamMemberIds = [...new Set(project.team?.members?.map((m) => m.userId) ?? [])];
  const teamUsers =
    teamMemberIds.length > 0 ?
      await prisma.user.findMany({
        where: { id: { in: teamMemberIds }, deletedAt: null },
        select: { id: true, firstName: true, lastName: true, email: true, status: true, department: true },
      })
    : [];

  const ticketCountWhere: Prisma.TicketWhereInput = { projectId: req.params.id, deletedAt: null };
  applyCodemagenTicketVisibility(ticketCountWhere, codemagenEnabled);
  const bySource = await prisma.ticket.groupBy({
    by: ['source'],
    where: ticketCountWhere,
    _count: true,
  });
  const ticketCountBySource = Object.fromEntries(bySource.map((r) => [r.source, r._count]));

  res.json({
    success: true,
    data: {
      project: {
        ...project,
        members: filterVisibleMembershipUsers(project.members, codemagenEnabled),
      },
      teamUsers: filterVisibleUsers(teamUsers, codemagenEnabled),
      ticketCountBySource,
    },
  });
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
    role: z.enum(['pm', 'lead', 'developer', 'qa', 'tester', 'stakeholder']).transform((value) =>
      value === 'tester' ? 'qa' : value,
    ),
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

const WorkflowStateSchema = z.object({
  name: z.string().min(1).max(80),
  slug: z.string().min(1).max(80).regex(/^[a-z0-9_-]+$/i, 'Slug can only use letters, numbers, underscores, and hyphens'),
  color: z.string().min(1).max(32).default('#6366f1'),
  order: z.number().int().optional(),
  isDefault: z.boolean().optional(),
  isFinal: z.boolean().optional(),
  wipLimit: z.number().int().positive().nullable().optional(),
});

const WorkflowReorderSchema = z.object({
  states: z.array(z.object({
    id: z.string(),
    order: z.number().int(),
    name: z.string().min(1).optional(),
    slug: z.string().min(1).max(80).regex(/^[a-z0-9_-]+$/i).optional(),
    color: z.string().min(1).max(32).optional(),
    isDefault: z.boolean().optional(),
    isFinal: z.boolean().optional(),
    wipLimit: z.number().int().positive().nullable().optional(),
  })).min(1),
});

const WorkflowTransitionConfigSchema = z.object({
  transitions: z.array(z.object({
    fromStateId: z.string().uuid(),
    toStateId: z.string().uuid(),
    requiresRole: z.string().trim().min(1).nullable().optional(),
    requiresNote: z.boolean().optional(),
  })),
});

const WorkflowDeleteSchema = z.object({
  replacementStateId: z.string().uuid().optional(),
});

router.get('/:id/workflow/config', requirePermission('projects', 'read'), async (req, res) => {
  const [states, transitions] = await Promise.all([
    prisma.workflowState.findMany({
      where: { projectId: req.params.id },
      orderBy: { order: 'asc' },
    }),
    prisma.workflowTransition.findMany({
      where: { fromState: { projectId: req.params.id } },
      orderBy: [{ fromStateId: 'asc' }, { toStateId: 'asc' }],
    }),
  ]);

  res.json({ success: true, data: { states, transitions } });
});

router.patch('/:id/workflow', requirePermission('projects', 'update'), async (req: AuthRequest, res) => {
  const parsed = WorkflowReorderSchema.parse(req.body);

  await prisma.$transaction(async (tx) => {
    if (parsed.states.some((state) => state.isDefault)) {
      await tx.workflowState.updateMany({
        where: { projectId: req.params.id },
        data: { isDefault: false },
      });
    }

    await Promise.all(
      parsed.states.map((s) =>
        tx.workflowState.updateMany({
          where: { id: s.id, projectId: req.params.id },
          data: {
            order: s.order,
            ...(s.name !== undefined ? { name: s.name } : {}),
            ...(s.slug !== undefined ? { slug: s.slug } : {}),
            ...(s.color !== undefined ? { color: s.color } : {}),
            ...(s.isDefault !== undefined ? { isDefault: s.isDefault } : {}),
            ...(s.isFinal !== undefined ? { isFinal: s.isFinal } : {}),
            ...(s.wipLimit !== undefined ? { wipLimit: s.wipLimit } : {}),
          },
        }),
      ),
    );
  });

  const workflowStates = await prisma.workflowState.findMany({
    where: { projectId: req.params.id },
    orderBy: { order: 'asc' },
  });
  emitBoardEvent({ type: 'workflow.updated', projectId: req.params.id, at: new Date().toISOString() });
  res.json({ success: true, data: workflowStates });
});

router.post('/:id/workflow/states', requirePermission('projects', 'update'), async (req: AuthRequest, res) => {
  const parsed = WorkflowStateSchema.parse(req.body);
  const currentMax = await prisma.workflowState.aggregate({
    where: { projectId: req.params.id },
    _max: { order: true },
  });

  const state = await prisma.$transaction(async (tx) => {
    if (parsed.isDefault) {
      await tx.workflowState.updateMany({
        where: { projectId: req.params.id },
        data: { isDefault: false },
      });
    }

    return tx.workflowState.create({
      data: {
        projectId: req.params.id,
        name: parsed.name,
        slug: parsed.slug,
        color: parsed.color,
        order: parsed.order ?? (currentMax._max.order ?? -1) + 1,
        isDefault: parsed.isDefault ?? false,
        isFinal: parsed.isFinal ?? false,
        wipLimit: parsed.wipLimit ?? null,
      },
    });
  });

  emitBoardEvent({ type: 'workflow.updated', projectId: req.params.id, at: new Date().toISOString() });
  res.status(201).json({ success: true, data: state });
});

router.patch('/:id/workflow/states/:stateId', requirePermission('projects', 'update'), async (req: AuthRequest, res) => {
  const parsed = WorkflowStateSchema.partial().parse(req.body);
  const existing = await prisma.workflowState.findFirst({
    where: { id: req.params.stateId, projectId: req.params.id },
    select: { id: true },
  });
  if (!existing) throw new AppError(404, 'Workflow state not found', 'NOT_FOUND');

  const state = await prisma.$transaction(async (tx) => {
    if (parsed.isDefault) {
      await tx.workflowState.updateMany({
        where: { projectId: req.params.id },
        data: { isDefault: false },
      });
    }

    return tx.workflowState.update({
      where: { id: req.params.stateId },
      data: parsed,
    });
  });

  emitBoardEvent({ type: 'workflow.updated', projectId: req.params.id, at: new Date().toISOString() });
  res.json({ success: true, data: state });
});

router.delete('/:id/workflow/states/:stateId', requirePermission('projects', 'update'), async (req: AuthRequest, res) => {
  const parsed = WorkflowDeleteSchema.parse(req.body ?? {});
  const state = await prisma.workflowState.findFirst({
    where: { id: req.params.stateId, projectId: req.params.id },
  });
  if (!state) throw new AppError(404, 'Workflow state not found', 'NOT_FOUND');

  const remainingCount = await prisma.workflowState.count({ where: { projectId: req.params.id } });
  if (remainingCount <= 1) throw new AppError(400, 'Project must keep at least one workflow state', 'BAD_REQUEST');

  const affectedTickets = await prisma.ticket.count({
    where: { projectId: req.params.id, workflowStateId: req.params.stateId, deletedAt: null },
  });

  if (affectedTickets > 0 && !parsed.replacementStateId) {
    throw new AppError(400, 'Choose a replacement state before deleting a state with tickets', 'REPLACEMENT_REQUIRED');
  }

  if (parsed.replacementStateId) {
    const replacement = await prisma.workflowState.findFirst({
      where: { id: parsed.replacementStateId, projectId: req.params.id },
      select: { id: true },
    });
    if (!replacement) throw new AppError(400, 'Replacement state must belong to the same project', 'BAD_STATE');
  }

  await prisma.$transaction(async (tx) => {
    if (parsed.replacementStateId) {
      await tx.ticket.updateMany({
        where: { projectId: req.params.id, workflowStateId: req.params.stateId, deletedAt: null },
        data: { workflowStateId: parsed.replacementStateId },
      });
    }

    await tx.workflowTransition.deleteMany({
      where: {
        OR: [{ fromStateId: req.params.stateId }, { toStateId: req.params.stateId }],
      },
    });

    await tx.workflowState.delete({
      where: { id: req.params.stateId },
    });

    if (state.isDefault && parsed.replacementStateId) {
      await tx.workflowState.update({
        where: { id: parsed.replacementStateId },
        data: { isDefault: true },
      });
    }
  });

  emitBoardEvent({ type: 'workflow.updated', projectId: req.params.id, at: new Date().toISOString() });
  res.json({ success: true, message: 'Workflow state deleted' });
});

router.put('/:id/workflow/transitions', requirePermission('projects', 'update'), async (req: AuthRequest, res) => {
  const parsed = WorkflowTransitionConfigSchema.parse(req.body);
  const stateIds = await prisma.workflowState.findMany({
    where: { projectId: req.params.id },
    select: { id: true },
  });
  const validIds = new Set(stateIds.map((state) => state.id));

  for (const transition of parsed.transitions) {
    if (!validIds.has(transition.fromStateId) || !validIds.has(transition.toStateId)) {
      throw new AppError(400, 'Transitions must reference workflow states in the same project', 'BAD_TRANSITION');
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.workflowTransition.deleteMany({
      where: { fromStateId: { in: [...validIds] } },
    });

    if (parsed.transitions.length > 0) {
      await tx.workflowTransition.createMany({
        data: parsed.transitions.map((transition) => ({
          fromStateId: transition.fromStateId,
          toStateId: transition.toStateId,
          requiresRole: transition.requiresRole ?? null,
          requiresNote: transition.requiresNote ?? false,
        })),
      });
    }
  });

  const transitions = await prisma.workflowTransition.findMany({
    where: { fromStateId: { in: [...validIds] } },
    orderBy: [{ fromStateId: 'asc' }, { toStateId: 'asc' }],
  });
  emitBoardEvent({ type: 'workflow.updated', projectId: req.params.id, at: new Date().toISOString() });
  res.json({ success: true, data: transitions });
});

export default router;
