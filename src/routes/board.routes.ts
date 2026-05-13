import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { authenticate, requirePermission, AuthRequest } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { config } from '../utils/config';
import type { Prisma } from '@prisma/client';
import { emitBoardEvent, subscribeToBoardEvents } from '../services/board-events.service';
import {
  assertBoardProjectAccess,
  buildBoardTicketWhere,
  getInitialBoardOrder,
  transitionTicketWorkflow,
  type BoardActor,
} from '../services/ticket-transition.service';
import { filterVisibleUsers, getTicketCompanyLabel, getCodemagenEnabled } from '../utils/system-settings';

const router = Router();

const boardQuerySchema = z.object({
  sprintId: z.string().optional(),
  assigneeId: z.string().optional(),
  search: z.string().optional(),
  type: z.string().optional(),
  priority: z.string().optional(),
  tag: z.string().optional(),
  unassigned: z.coerce.boolean().optional(),
  includeDone: z.coerce.boolean().optional(),
});

const boardCreateSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  type: z.enum(['TASK', 'BUG', 'STORY', 'EPIC', 'SUBTASK']).default('TASK'),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  assigneeIds: z.array(z.string().uuid()).optional(),
  sprintId: z.union([z.string().uuid(), z.null()]).optional(),
  storyPoints: z.number().optional(),
  module: z.string().optional(),
  screen: z.string().optional(),
  tags: z.array(z.string()).default([]),
  workflowStateId: z.string().uuid().optional(),
});

const boardUpdateSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().optional(),
  type: z.enum(['TASK', 'BUG', 'STORY', 'EPIC', 'SUBTASK']).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  assigneeIds: z.array(z.string().uuid()).optional(),
  sprintId: z.union([z.string().uuid(), z.null()]).optional(),
  storyPoints: z.number().nullable().optional(),
  module: z.string().optional(),
  screen: z.string().optional(),
  tags: z.array(z.string()).optional(),
  workflowStateId: z.string().uuid().optional(),
  note: z.string().optional(),
});

const boardMoveSchema = z.object({
  ticketId: z.string().uuid(),
  workflowStateId: z.string().uuid(),
  targetIndex: z.number().int().min(0).optional(),
  note: z.string().optional(),
});

async function getProjectCompanyId(projectId: string): Promise<string | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { companyId: true },
  });
  return project?.companyId ?? null;
}

async function assertSprintBelongsToProject(projectId: string, sprintId: string | null | undefined): Promise<void> {
  if (!sprintId) return;
  const sprint = await prisma.sprint.findFirst({
    where: { id: sprintId, projectId },
    select: { id: true },
  });
  if (!sprint) throw new AppError(400, 'Sprint does not belong to this project', 'BAD_SPRINT');
}

async function loadBoardEventActor(accessToken: string): Promise<BoardActor> {
  const decoded = jwt.verify(accessToken, config.jwt.secret) as { sub: string };
  const user = await prisma.user.findFirst({
    where: { id: decoded.sub, deletedAt: null },
    select: {
      id: true,
      status: true,
      roles: { select: { role: { select: { name: true } } } },
    },
  });
  if (!user || user.status !== 'ACTIVE') throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
  return { id: user.id, roles: user.roles.map((item) => item.role.name) };
}

async function getBoardConfig(projectId: string, actor: BoardActor) {
  await assertBoardProjectAccess(projectId, actor);
  const codemagenEnabled = await getCodemagenEnabled();

  const [project, workflowStates, transitions, sprints, members] = await Promise.all([
    prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { id: true, name: true, key: true },
    }),
    prisma.workflowState.findMany({
      where: { projectId },
      orderBy: { order: 'asc' },
    }),
    prisma.workflowTransition.findMany({
      where: {
        fromState: { projectId },
      },
      select: {
        id: true,
        fromStateId: true,
        toStateId: true,
        requiresRole: true,
        requiresNote: true,
      },
      orderBy: [{ fromStateId: 'asc' }, { toStateId: 'asc' }],
    }),
    prisma.sprint.findMany({
      where: { projectId },
      select: { id: true, name: true, status: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.projectMember.findMany({
      where: { projectId },
      select: {
        userId: true,
        role: true,
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            avatar: true,
            department: true,
          },
        },
      },
      orderBy: { joinedAt: 'asc' },
    }),
  ]);

  if (!project) throw new AppError(404, 'Project not found', 'NOT_FOUND');

  return {
    project,
    workflowStates,
    transitions,
    sprints,
    members: members
      .filter((member) => filterVisibleUsers([member.user], codemagenEnabled).length > 0)
      .map((member) => ({
        ...member,
        user: member.user,
      })),
    codemagenEnabled,
  };
}

// GET /api/board/:projectId/events — live board updates
router.get('/:projectId/events', async (req, res) => {
  const accessToken = typeof req.query.accessToken === 'string' ? req.query.accessToken : '';
  if (!accessToken) throw new AppError(401, 'Missing access token', 'UNAUTHORIZED');

  const actor = await loadBoardEventActor(accessToken);
  await assertBoardProjectAccess(req.params.projectId, actor);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write(`event: ready\ndata: ${JSON.stringify({ projectId: req.params.projectId, at: new Date().toISOString() })}\n\n`);

  const keepAlive = setInterval(() => {
    res.write(`event: ping\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  }, 20_000);

  const unsubscribe = subscribeToBoardEvents(req.params.projectId, (event) => {
    res.write(`event: board\ndata: ${JSON.stringify(event)}\n\n`);
  });

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
    res.end();
  });
});

router.use(authenticate);

// GET /api/board/:projectId/config — board metadata / workflow admin data
router.get('/:projectId/config', requirePermission('tickets', 'read'), async (req: AuthRequest, res) => {
  const data = await getBoardConfig(req.params.projectId, { id: req.user!.id, roles: req.user!.roles });
  res.json({ success: true, data });
});

// GET /api/board/:projectId/tickets/:ticketId — board-scoped ticket detail
router.get('/:projectId/tickets/:ticketId', requirePermission('tickets', 'read'), async (req: AuthRequest, res) => {
  await assertBoardProjectAccess(req.params.projectId, { id: req.user!.id, roles: req.user!.roles });
  const codemagenEnabled = await getCodemagenEnabled();

  const ticket = await prisma.ticket.findFirst({
    where: {
      id: req.params.ticketId,
      projectId: req.params.projectId,
      deletedAt: null,
    },
    include: {
      assignees: { select: { id: true, firstName: true, lastName: true, avatar: true, email: true, department: true } },
      reporter: { select: { id: true, firstName: true, lastName: true } },
      workflowState: true,
      project: { select: { id: true, name: true, key: true } },
      company: { select: { id: true, name: true, organisationId: true } },
      sprint: { select: { id: true, name: true, status: true } },
      comments: {
        where: { deletedAt: null },
        include: { author: { select: { id: true, firstName: true, lastName: true, avatar: true } } },
        orderBy: { createdAt: 'asc' },
      },
      attachments: true,
      history: { orderBy: { createdAt: 'desc' }, take: 50 },
      checklistItems: { orderBy: { sortOrder: 'asc' } },
      linksFrom: {
        include: { linkedTicket: { select: { id: true, title: true, type: true } } },
      },
      watchers: {
        include: {
          user: { select: { id: true, firstName: true, lastName: true, email: true, avatar: true, department: true } },
        },
      },
      _count: { select: { comments: true, attachments: true, votes: true } },
    },
  });

  if (!ticket) throw new AppError(404, 'Ticket not found in this board', 'NOT_FOUND');

  res.json({
    success: true,
    data: {
      ...ticket,
      assignees: filterVisibleUsers(ticket.assignees, codemagenEnabled),
      companyLabel: getTicketCompanyLabel({ company: ticket.company }),
    },
  });
});

// POST /api/board/:projectId/tickets — quick create from board
router.post('/:projectId/tickets', requirePermission('tickets', 'create'), async (req: AuthRequest, res) => {
  await assertBoardProjectAccess(req.params.projectId, { id: req.user!.id, roles: req.user!.roles });
  const body = boardCreateSchema.parse(req.body ?? {});
  const codemagenEnabled = await getCodemagenEnabled();

  const [defaultState, projectCompanyId] = await Promise.all([
    body.workflowStateId
      ? prisma.workflowState.findFirst({
          where: { id: body.workflowStateId, projectId: req.params.projectId },
        })
      : prisma.workflowState.findFirst({
          where: { projectId: req.params.projectId, isDefault: true },
        }),
    getProjectCompanyId(req.params.projectId),
  ]);

  if (!defaultState) throw new AppError(400, 'Project has no workflow state configured', 'BAD_STATE');
  await assertSprintBelongsToProject(req.params.projectId, body.sprintId ?? undefined);

  const ticket = await prisma.ticket.create({
    data: {
      projectId: req.params.projectId,
      companyId: projectCompanyId ?? undefined,
      title: body.title,
      description: body.description,
      type: body.type,
      priority: body.priority,
      sprintId: body.sprintId ?? undefined,
      storyPoints: body.storyPoints,
      module: body.module?.trim() || undefined,
      screen: body.screen?.trim() || undefined,
      tags: body.tags,
      reporterId: req.user!.id,
      workflowStateId: defaultState.id,
      boardOrder: await getInitialBoardOrder(req.params.projectId, defaultState.id),
      assignees: body.assigneeIds?.length ? { connect: body.assigneeIds.map((id) => ({ id })) } : undefined,
    },
    include: {
      assignees: { select: { id: true, firstName: true, lastName: true, avatar: true, department: true } },
      workflowState: true,
      _count: { select: { comments: true, attachments: true } },
      project: { select: { id: true, name: true, key: true } },
      company: { select: { id: true, name: true, organisationId: true } },
    },
  });

  await prisma.ticketHistory.create({
    data: { ticketId: ticket.id, actorId: req.user!.id, field: 'created', newValue: 'ticket created from board' },
  });
  await prisma.ticketStatusDuration.create({
    data: { ticketId: ticket.id, status: defaultState.id, startedAt: new Date() },
  });

  emitBoardEvent({
    type: 'ticket.created',
    projectId: req.params.projectId,
    ticketId: ticket.id,
    workflowStateId: ticket.workflowStateId,
    at: new Date().toISOString(),
  });

  res.status(201).json({
    success: true,
    data: {
      ...ticket,
      assignees: filterVisibleUsers(ticket.assignees, codemagenEnabled),
      companyLabel: getTicketCompanyLabel({ company: ticket.company }),
    },
  });
});

// PATCH /api/board/:projectId/tickets/:ticketId — board-scoped quick updates
router.patch('/:projectId/tickets/:ticketId', requirePermission('tickets', 'update'), async (req: AuthRequest, res) => {
  await assertBoardProjectAccess(req.params.projectId, { id: req.user!.id, roles: req.user!.roles });
  const body = boardUpdateSchema.parse(req.body ?? {});
  await assertSprintBelongsToProject(req.params.projectId, body.sprintId ?? undefined);
  const codemagenEnabled = await getCodemagenEnabled();

  const existing = await prisma.ticket.findFirst({
    where: { id: req.params.ticketId, projectId: req.params.projectId, deletedAt: null },
    include: {
      assignees: { select: { id: true } },
      workflowState: { select: { id: true, name: true } },
    },
  });
  if (!existing) throw new AppError(404, 'Ticket not found in this board', 'NOT_FOUND');

  const cleanUpdates = Object.fromEntries(
    Object.entries(body).filter(([key, value]) => key !== 'workflowStateId' && key !== 'assigneeIds' && key !== 'note' && value !== undefined),
  ) as Record<string, unknown>;

  if (Object.keys(cleanUpdates).length > 0 || body.assigneeIds !== undefined) {
    await prisma.ticket.update({
      where: { id: existing.id },
      data: {
        ...(cleanUpdates as any),
        ...(body.assigneeIds !== undefined ? { assignees: { set: body.assigneeIds.map((id) => ({ id })) } } : {}),
      },
    });

    const historyEntries = Object.entries(cleanUpdates).map(([field, newValue]) => ({
      ticketId: existing.id,
      actorId: req.user!.id,
      field,
      oldValue: String((existing as any)[field] ?? ''),
      newValue: String(newValue ?? ''),
    }));

    if (historyEntries.length) {
      await prisma.ticketHistory.createMany({ data: historyEntries });
    }
  }

  if (body.workflowStateId && body.workflowStateId !== existing.workflowStateId) {
    await transitionTicketWorkflow({
      ticketId: existing.id,
      projectId: req.params.projectId,
      actor: { id: req.user!.id, roles: req.user!.roles },
      workflowStateId: body.workflowStateId,
      note: body.note,
    });
  } else {
    emitBoardEvent({
      type: 'ticket.updated',
      projectId: req.params.projectId,
      ticketId: existing.id,
      workflowStateId: existing.workflowStateId,
      at: new Date().toISOString(),
    });
  }

  const ticket = await prisma.ticket.findFirst({
    where: { id: existing.id, deletedAt: null },
    include: {
      assignees: { select: { id: true, firstName: true, lastName: true, avatar: true, email: true, department: true } },
      reporter: { select: { id: true, firstName: true, lastName: true } },
      workflowState: true,
      project: { select: { id: true, name: true, key: true } },
      company: { select: { id: true, name: true, organisationId: true } },
      sprint: { select: { id: true, name: true, status: true } },
      comments: {
        where: { deletedAt: null },
        include: { author: { select: { id: true, firstName: true, lastName: true, avatar: true } } },
        orderBy: { createdAt: 'asc' },
      },
      attachments: true,
      history: { orderBy: { createdAt: 'desc' }, take: 50 },
      checklistItems: { orderBy: { sortOrder: 'asc' } },
      linksFrom: {
        include: { linkedTicket: { select: { id: true, title: true, type: true } } },
      },
      watchers: {
        include: {
          user: { select: { id: true, firstName: true, lastName: true, email: true, avatar: true, department: true } },
        },
      },
      _count: { select: { comments: true, attachments: true, votes: true } },
    },
  });

  res.json({
    success: true,
    data: {
      ...ticket!,
      assignees: filterVisibleUsers(ticket!.assignees, codemagenEnabled),
      companyLabel: getTicketCompanyLabel({ company: ticket!.company }),
    },
  });
});

// GET /api/board/:projectId — Kanban board data
router.get('/:projectId', requirePermission('tickets', 'read'), async (req: AuthRequest, res) => {
  const actor = { id: req.user!.id, roles: req.user!.roles };
  const filters = boardQuerySchema.parse(req.query ?? {});
  const where = await buildBoardTicketWhere(req.params.projectId, actor, filters);
  const codemagenEnabled = await getCodemagenEnabled();

  const [config, tickets] = await Promise.all([
    getBoardConfig(req.params.projectId, actor),
    prisma.ticket.findMany({
      where,
      include: {
        assignees: { select: { id: true, firstName: true, lastName: true, avatar: true, department: true } },
        workflowState: true,
        sprint: { select: { id: true, name: true, status: true } },
        company: { select: { id: true, name: true, organisationId: true } },
        _count: { select: { comments: true, attachments: true } },
      },
      orderBy: [{ boardOrder: 'asc' }, { updatedAt: 'desc' }],
    }),
  ]);

  const board = config.workflowStates.map((state) => {
    const stateTickets = tickets
      .filter((ticket) => ticket.workflowStateId === state.id)
      .map((ticket) => ({
        ...ticket,
        assignees: filterVisibleUsers(ticket.assignees, codemagenEnabled),
        companyLabel: getTicketCompanyLabel({ company: ticket.company }),
      }));

    return {
      ...state,
      ticketCount: stateTickets.length,
      wipExceeded: typeof state.wipLimit === 'number' && state.wipLimit > 0 ? stateTickets.length > state.wipLimit : false,
      tickets: stateTickets,
    };
  });

  const tagOptions = [...new Set(tickets.flatMap((ticket) => ticket.tags ?? []))].sort((a, b) => a.localeCompare(b));

  res.json({
    success: true,
    data: {
      project: config.project,
      filters: {
        ...filters,
        availableTags: tagOptions,
        availableSprints: config.sprints,
        availableMembers: config.members,
      },
      workflowStates: config.workflowStates,
      transitions: config.transitions,
      board,
    },
  });
});

// PATCH /api/board/:projectId/move — Drag & drop ticket
router.patch('/:projectId/move', requirePermission('tickets', 'update'), async (req: AuthRequest, res) => {
  const body = boardMoveSchema.parse(req.body ?? {});
  const ticket = await transitionTicketWorkflow({
    ticketId: body.ticketId,
    projectId: req.params.projectId,
    actor: { id: req.user!.id, roles: req.user!.roles },
    workflowStateId: body.workflowStateId,
    targetIndex: body.targetIndex,
    note: body.note,
  });

  res.json({ success: true, data: ticket });
});

export default router;
