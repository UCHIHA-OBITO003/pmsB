import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { authenticate, requirePermission, AuthRequest } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { notifyTicketUpdated } from '../services/ticket-notification.service';
import { applyTicketParticipantScope } from '../utils/ticket-access';
import type { Prisma } from '@prisma/client';

const router = Router();
router.use(authenticate);

// GET /api/board/:projectId — Kanban board data
router.get('/:projectId', requirePermission('tickets', 'read'), async (req: AuthRequest, res) => {
  const { sprintId } = req.query as { sprintId?: string };

  const workflowStates = await prisma.workflowState.findMany({
    where: { projectId: req.params.projectId },
    orderBy: { order: 'asc' },
  });

  const ticketWhere: any = {
    projectId: req.params.projectId,
    deletedAt: null,
  };

  if (sprintId) {
    ticketWhere.sprintId = sprintId;
  } else {
    // Active sprint tickets
    const activeSprint = await prisma.sprint.findFirst({
      where: { projectId: req.params.projectId, status: 'ACTIVE' },
    });
    if (activeSprint) ticketWhere.sprintId = activeSprint.id;
  }

  applyTicketParticipantScope(ticketWhere, req.user!.id, req.user!.roles);

  const tickets = await prisma.ticket.findMany({
    where: ticketWhere,
    include: {
      assignees: { select: { id: true, firstName: true, lastName: true, avatar: true } },
      workflowState: true,
      _count: { select: { comments: true, attachments: true } },
    },
    orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
  });

  // Group tickets by workflow state
  const board = workflowStates.map((state) => ({
    ...state,
    tickets: tickets.filter((t) => t.workflowStateId === state.id),
  }));

  res.json({ success: true, data: board });
});

// PATCH /api/board/:projectId/move — Drag & drop ticket
router.patch('/:projectId/move', requirePermission('tickets', 'update'), async (req: AuthRequest, res) => {
  const { ticketId, workflowStateId } = z
    .object({
      ticketId: z.string().min(1),
      workflowStateId: z.string().min(1),
      order: z.number().optional(),
    })
    .parse(req.body);

  const moveWhere: Prisma.TicketWhereInput = {
    id: ticketId,
    projectId: req.params.projectId,
    deletedAt: null,
  };
  applyTicketParticipantScope(moveWhere, req.user!.id, req.user!.roles);

  const existing = await prisma.ticket.findFirst({
    where: moveWhere,
    include: { assignees: { select: { id: true } }, workflowState: { select: { id: true, name: true } } },
  });
  if (!existing) throw new AppError(404, 'Ticket not found in this project', 'NOT_FOUND');

  const previousWorkflowStateName = existing.workflowState?.name ?? null;
  const fromStateId = existing.workflowStateId ?? undefined;

  if (fromStateId === workflowStateId) {
    const unchanged = await prisma.ticket.findUnique({ where: { id: ticketId } });
    return res.json({ success: true, data: unchanged });
  }

  const newWs = await prisma.workflowState.findFirst({
    where: { id: workflowStateId, projectId: req.params.projectId },
    select: { name: true },
  });
  if (!newWs) {
    throw new AppError(400, 'Workflow column does not belong to this project', 'BAD_STATE');
  }

  const ticket = await prisma.ticket.update({
    where: { id: ticketId },
    data: {
      workflowStateId,
      ...(workflowStateId && {
        startedAt: undefined,
        completedAt: undefined,
      }),
    },
  });

  await prisma.ticketHistory.create({
    data: {
      ticketId,
      actorId: req.user!.id,
      field: 'workflowStateId',
      oldValue: previousWorkflowStateName ?? fromStateId ?? '',
      newValue: newWs?.name ?? workflowStateId,
    },
  });

  if (fromStateId && fromStateId !== workflowStateId) {
    await prisma.ticketStatusDuration.updateMany({
      where: { ticketId, endedAt: null },
      data: { endedAt: new Date() },
    });
    await prisma.ticketStatusDuration.create({
      data: { ticketId, status: workflowStateId, startedAt: new Date() },
    });
  }

  void notifyTicketUpdated(
    { assignees: existing.assignees },
    ticketId,
    { workflowStateId },
    req.user!.id,
    { previousWorkflowStateName },
  );

  res.json({ success: true, data: ticket });
});

export default router;
