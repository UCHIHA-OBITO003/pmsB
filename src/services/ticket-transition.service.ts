import type { Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { AppError } from '../middleware/errorHandler';
import { seesAllTickets } from '../utils/ticket-access';
import { applyCodemagenTicketVisibility, getCodemagenEnabled } from '../utils/system-settings';
import { emitBoardEvent } from './board-events.service';

const BOARD_ORDER_STEP = 1024;
const MIN_ORDER_GAP = 0.0001;

export type BoardActor = {
  id: string;
  roles: string[];
};

export type BoardFilters = {
  sprintId?: string;
  assigneeId?: string;
  search?: string;
  type?: string;
  priority?: string;
  tag?: string;
  unassigned?: boolean;
  includeDone?: boolean;
};

type BoardTicketPlacement = {
  id: string;
  boardOrder: number;
};

type WorkflowStateShape = {
  id: string;
  name: string;
  slug: string;
  isDefault: boolean;
  isFinal: boolean;
};

function mergeWhereAnd(where: Prisma.TicketWhereInput, extra: Prisma.TicketWhereInput) {
  const prev = where.AND;
  if (prev === undefined) {
    where.AND = [extra];
  } else if (Array.isArray(prev)) {
    where.AND = [...prev, extra];
  } else {
    where.AND = [prev, extra];
  }
}

async function rebalanceBoardOrder(projectId: string, workflowStateId: string, excludeTicketId?: string): Promise<void> {
  const rows = await prisma.ticket.findMany({
    where: {
      projectId,
      workflowStateId,
      deletedAt: null,
      ...(excludeTicketId ? { id: { not: excludeTicketId } } : {}),
    },
    select: { id: true },
    orderBy: [{ boardOrder: 'asc' }, { updatedAt: 'asc' }],
  });

  if (rows.length === 0) return;

  await prisma.$transaction(
    rows.map((row, index) =>
      prisma.ticket.update({
        where: { id: row.id },
        data: { boardOrder: (index + 1) * BOARD_ORDER_STEP },
      }),
    ),
  );
}

async function listBoardPlacements(projectId: string, workflowStateId: string, excludeTicketId?: string): Promise<BoardTicketPlacement[]> {
  return prisma.ticket.findMany({
    where: {
      projectId,
      workflowStateId,
      deletedAt: null,
      ...(excludeTicketId ? { id: { not: excludeTicketId } } : {}),
    },
    select: { id: true, boardOrder: true },
    orderBy: [{ boardOrder: 'asc' }, { updatedAt: 'asc' }],
  });
}

async function ensureBoardOrderGap(projectId: string, workflowStateId: string, targetIndex: number, excludeTicketId?: string) {
  let rows = await listBoardPlacements(projectId, workflowStateId, excludeTicketId);
  if (rows.length === 0) return rows;

  const safeIndex = Math.min(Math.max(targetIndex, 0), rows.length);
  if (safeIndex === 0 || safeIndex === rows.length) return rows;

  const prev = rows[safeIndex - 1]?.boardOrder ?? 0;
  const next = rows[safeIndex]?.boardOrder ?? prev + BOARD_ORDER_STEP;
  if (next - prev > MIN_ORDER_GAP) return rows;

  await rebalanceBoardOrder(projectId, workflowStateId, excludeTicketId);
  rows = await listBoardPlacements(projectId, workflowStateId, excludeTicketId);
  return rows;
}

async function resolveBoardOrder(projectId: string, workflowStateId: string, targetIndex?: number, excludeTicketId?: string): Promise<number> {
  const rows = await ensureBoardOrderGap(projectId, workflowStateId, targetIndex ?? Number.MAX_SAFE_INTEGER, excludeTicketId);
  if (rows.length === 0) return BOARD_ORDER_STEP;

  const safeIndex = Math.min(Math.max(targetIndex ?? rows.length, 0), rows.length);
  if (safeIndex <= 0) return rows[0].boardOrder - BOARD_ORDER_STEP;
  if (safeIndex >= rows.length) return rows[rows.length - 1].boardOrder + BOARD_ORDER_STEP;

  return (rows[safeIndex - 1].boardOrder + rows[safeIndex].boardOrder) / 2;
}

async function loadWorkflowState(projectId: string, workflowStateId: string): Promise<WorkflowStateShape> {
  const workflowState = await prisma.workflowState.findFirst({
    where: { id: workflowStateId, projectId },
    select: { id: true, name: true, slug: true, isDefault: true, isFinal: true },
  });
  if (!workflowState) {
    throw new AppError(400, 'Workflow column does not belong to this project', 'BAD_STATE');
  }
  return workflowState;
}

async function assertTransitionAllowed(fromStateId: string | null, toStateId: string, actor: BoardActor, note?: string): Promise<void> {
  if (!fromStateId || fromStateId === toStateId) return;

  const transitions = await prisma.workflowTransition.findMany({
    where: { fromStateId },
    select: { toStateId: true, requiresRole: true, requiresNote: true },
  });

  if (transitions.length === 0) return;

  const matched = transitions.find((transition) => transition.toStateId === toStateId);
  if (!matched) {
    throw new AppError(409, 'Transition is not allowed from the current workflow state', 'BAD_TRANSITION');
  }

  if (matched.requiresRole && !actor.roles.includes('admin') && !actor.roles.includes(matched.requiresRole)) {
    throw new AppError(403, `Transition requires role "${matched.requiresRole}"`, 'FORBIDDEN');
  }

  if (matched.requiresNote && !note?.trim()) {
    throw new AppError(400, 'Transition note is required for this workflow move', 'TRANSITION_NOTE_REQUIRED');
  }
}

function computeLifecyclePatch(
  existing: { startedAt: Date | null; completedAt: Date | null },
  fromState: WorkflowStateShape | null,
  toState: WorkflowStateShape,
): { startedAt?: Date | null; completedAt?: Date | null } {
  const now = new Date();
  const patch: { startedAt?: Date | null; completedAt?: Date | null } = {};

  if (toState.isDefault) {
    patch.startedAt = null;
    patch.completedAt = null;
    return patch;
  }

  if (!existing.startedAt || fromState?.isDefault) {
    patch.startedAt = now;
  }

  if (toState.isFinal) {
    patch.completedAt = existing.completedAt ?? now;
  } else if (fromState?.isFinal) {
    patch.completedAt = null;
  }

  return patch;
}

export async function assertBoardProjectAccess(projectId: string, actor: BoardActor): Promise<void> {
  if (seesAllTickets(actor.roles)) return;

  const membership = await prisma.projectMember.findUnique({
    where: {
      projectId_userId: {
        projectId,
        userId: actor.id,
      },
    },
    select: { userId: true },
  });

  if (!membership) {
    throw new AppError(403, 'You are not a member of this project board', 'FORBIDDEN');
  }
}

export async function buildBoardTicketWhere(projectId: string, actor: BoardActor, filters: BoardFilters): Promise<Prisma.TicketWhereInput> {
  await assertBoardProjectAccess(projectId, actor);

  const where: Prisma.TicketWhereInput = {
    projectId,
    deletedAt: null,
  };

  applyCodemagenTicketVisibility(where, await getCodemagenEnabled());

  if (filters.sprintId) {
    if (filters.sprintId === 'backlog') {
      where.sprintId = null;
    } else if (filters.sprintId === 'active') {
      const activeSprint = await prisma.sprint.findFirst({
        where: { projectId, status: 'ACTIVE' },
        select: { id: true },
      });
      mergeWhereAnd(where, activeSprint ? { sprintId: activeSprint.id } : { id: '__no_active_sprint__' });
    } else {
      where.sprintId = filters.sprintId;
    }
  }

  if (filters.assigneeId) {
    mergeWhereAnd(where, { assignees: { some: { id: filters.assigneeId } } });
  }

  if (filters.search?.trim()) {
    const needle = filters.search.trim();
    mergeWhereAnd(where, {
      OR: [
        { title: { contains: needle, mode: 'insensitive' } },
        { description: { contains: needle, mode: 'insensitive' } },
        { module: { contains: needle, mode: 'insensitive' } },
        { screen: { contains: needle, mode: 'insensitive' } },
      ],
    });
  }

  if (filters.type) where.type = filters.type as any;
  if (filters.priority) where.priority = filters.priority as any;
  if (filters.tag) mergeWhereAnd(where, { tags: { has: filters.tag } });
  if (filters.unassigned) mergeWhereAnd(where, { assignees: { none: {} } });
  if (!filters.includeDone) {
    mergeWhereAnd(where, {
      OR: [
        { workflowState: { is: { isFinal: false } } },
        { workflowStateId: null },
      ],
    });
  }

  return where;
}

export async function getInitialBoardOrder(projectId: string, workflowStateId: string): Promise<number> {
  return resolveBoardOrder(projectId, workflowStateId);
}

export async function transitionTicketWorkflow(args: {
  ticketId: string;
  projectId: string;
  actor: BoardActor;
  workflowStateId: string;
  targetIndex?: number;
  note?: string;
}): Promise<{ id: string; workflowStateId: string | null; boardOrder: number }> {
  await assertBoardProjectAccess(args.projectId, args.actor);

  const existing = await prisma.ticket.findFirst({
    where: {
      id: args.ticketId,
      projectId: args.projectId,
      deletedAt: null,
    },
    select: {
      id: true,
      projectId: true,
      workflowStateId: true,
      boardOrder: true,
      startedAt: true,
      completedAt: true,
      assignees: { select: { id: true } },
      workflowState: {
        select: {
          id: true,
          name: true,
          slug: true,
          isDefault: true,
          isFinal: true,
        },
      },
    },
  });

  if (!existing) {
    throw new AppError(404, 'Ticket not found in this project', 'NOT_FOUND');
  }

  const targetState = await loadWorkflowState(args.projectId, args.workflowStateId);
  await assertTransitionAllowed(existing.workflowStateId, targetState.id, args.actor, args.note);

  const isStateChange = existing.workflowStateId !== targetState.id;
  const boardOrder =
    isStateChange || args.targetIndex !== undefined
      ? await resolveBoardOrder(args.projectId, targetState.id, args.targetIndex, existing.id)
      : existing.boardOrder;

  const lifecyclePatch = isStateChange
    ? computeLifecyclePatch(existing, existing.workflowState as WorkflowStateShape | null, targetState)
    : {};

  const previousWorkflowStateName = existing.workflowState?.name ?? null;
  const updated = await prisma.ticket.update({
    where: { id: existing.id },
    data: {
      workflowStateId: targetState.id,
      boardOrder,
      ...lifecyclePatch,
    },
    select: { id: true, workflowStateId: true, boardOrder: true },
  });

  if (isStateChange) {
    await prisma.ticketHistory.create({
      data: {
        ticketId: existing.id,
        actorId: args.actor.id,
        field: 'workflowStateId',
        oldValue: previousWorkflowStateName ?? existing.workflowStateId ?? '',
        newValue: targetState.name,
      },
    });

    await prisma.ticketStatusDuration.updateMany({
      where: { ticketId: existing.id, endedAt: null },
      data: { endedAt: new Date() },
    });

    await prisma.ticketStatusDuration.create({
      data: {
        ticketId: existing.id,
        status: targetState.id,
        startedAt: new Date(),
      },
    });
  }

  if (args.note?.trim()) {
    await prisma.ticketComment.create({
      data: {
        ticketId: existing.id,
        authorId: args.actor.id,
        body: args.note.trim(),
      },
    });
  }

  emitBoardEvent({
    type: isStateChange ? 'ticket.moved' : 'ticket.updated',
    projectId: args.projectId,
    ticketId: existing.id,
    workflowStateId: targetState.id,
    at: new Date().toISOString(),
  });

  return updated;
}
