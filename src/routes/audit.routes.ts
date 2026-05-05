import { Router } from 'express';
import { prisma } from '../utils/prisma';
import { authenticate, requirePermission, requireRole } from '../middleware/auth';

const router = Router();
router.use(authenticate);

// GET /api/audit-logs?resource=&actorId=&action=&page=&limit=
router.get('/', requirePermission('audit', 'read'), async (req, res) => {
  const { resource, actorId, action, page = '1', limit = '50' } = req.query as Record<string, string>;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const where: Record<string, unknown> = {};
  if (resource) where.resource = resource;
  if (actorId) where.actorId = actorId;
  if (action) where.action = action;

  const [logs, total] = await prisma.$transaction([
    prisma.auditLog.findMany({
      where,
      include: { actor: { select: { id: true, firstName: true, lastName: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit),
    }),
    prisma.auditLog.count({ where }),
  ]);

  res.json({ success: true, data: { logs, total, page: parseInt(page) } });
});

// GET /api/audit-logs/merge-history — all user_merge events with rich metadata
router.get('/merge-history', requireRole('admin'), async (req, res) => {
  const { page = '1', limit = '30' } = req.query as Record<string, string>;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [logs, total] = await prisma.$transaction([
    prisma.auditLog.findMany({
      where: { action: 'user_merge' },
      include: { actor: { select: { id: true, firstName: true, lastName: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit),
    }),
    prisma.auditLog.count({ where: { action: 'user_merge' } }),
  ]);

  res.json({ success: true, data: { logs, total, page: parseInt(page) } });
});

// GET /api/audit-logs/reports/summary — high-level DB-change stats
router.get('/reports/summary', requireRole('admin', 'project_manager'), async (req, res) => {
  const since = req.query.since
    ? new Date(req.query.since as string)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [
    totalAuditLogs,
    mergeCount,
    ticketCreated,
    ticketUpdated,
    ticketDeleted,
    userCreated,
    userUpdated,
    projectCreated,
    projectUpdated,
    sprintCreated,
    recentMerges,
    ticketHistory,
  ] = await Promise.all([
    prisma.auditLog.count({ where: { createdAt: { gte: since } } }),
    prisma.auditLog.count({ where: { action: 'user_merge', createdAt: { gte: since } } }),
    prisma.auditLog.count({ where: { resource: 'ticket', action: 'create', createdAt: { gte: since } } }),
    prisma.auditLog.count({ where: { resource: 'ticket', action: 'update', createdAt: { gte: since } } }),
    prisma.auditLog.count({ where: { resource: 'ticket', action: 'delete', createdAt: { gte: since } } }),
    prisma.auditLog.count({ where: { resource: 'user', action: 'create', createdAt: { gte: since } } }),
    prisma.auditLog.count({ where: { resource: 'user', action: 'update', createdAt: { gte: since } } }),
    prisma.auditLog.count({ where: { resource: 'project', action: 'create', createdAt: { gte: since } } }),
    prisma.auditLog.count({ where: { resource: 'project', action: 'update', createdAt: { gte: since } } }),
    prisma.auditLog.count({ where: { resource: 'sprint', action: 'create', createdAt: { gte: since } } }),
    // 5 most recent merges with stats
    prisma.auditLog.findMany({
      where: { action: 'user_merge' },
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: { actor: { select: { id: true, firstName: true, lastName: true, email: true } } },
    }),
    // ticket history rows written (reassignments, status changes)
    prisma.ticketHistory.count({ where: { createdAt: { gte: since } } }),
  ]);

  // Active ticket counts  
  const [totalTickets, openTickets, importedLast30] = await Promise.all([
    prisma.ticket.count({ where: { deletedAt: null } }),
    prisma.ticket.count({ where: { deletedAt: null, workflowState: { isFinal: false } } }),
    prisma.ticket.count({
      where: {
        deletedAt: null,
        source: { not: 'manual' },
        createdAt: { gte: since },
      },
    }),
  ]);

  // Users with no role (data quality)
  const usersNoRole = await prisma.user.count({
    where: { deletedAt: null, status: 'ACTIVE', roles: { none: {} } },
  });

  // Tombstone (merged-away) count
  const tombstoneCount = await prisma.user.count({
    where: { email: { contains: '@pms.merge' } },
  });

  res.json({
    success: true,
    data: {
      since,
      totalAuditLogs,
      mergeCount,
      usersNoRole,
      tombstoneCount,
      tickets: {
        total: totalTickets,
        open: openTickets,
        importedLast30,
        historyRows: ticketHistory,
        created: ticketCreated,
        updated: ticketUpdated,
        deleted: ticketDeleted,
      },
      users: { created: userCreated, updated: userUpdated },
      projects: { created: projectCreated, updated: projectUpdated },
      sprints: { created: sprintCreated },
      recentMerges,
    },
  });
});

// GET /api/audit-logs/reports/ticket-adjustments — ticket-level reassignment digest
router.get('/reports/ticket-adjustments', requireRole('admin', 'project_manager'), async (req, res) => {
  const { page = '1', limit = '50' } = req.query as Record<string, string>;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [rows, total] = await prisma.$transaction([
    prisma.ticketHistory.findMany({
      where: {
        field: { in: ['assignees', 'reporter', 'status', 'workflowState'] },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit),
      include: {
        ticket: { select: { id: true, title: true, source: true } },
      },
    }),
    prisma.ticketHistory.count({
      where: { field: { in: ['assignees', 'reporter', 'status', 'workflowState'] } },
    }),
  ]);

  // Manually resolve actors since TicketHistory has no User relation in schema
  const actorIds = [...new Set(rows.map((r) => r.actorId).filter((id): id is string => Boolean(id)))];
  const actors = actorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, firstName: true, lastName: true, email: true },
      })
    : [];
  const actorMap = new Map(actors.map((a) => [a.id, a]));
  const rowsWithActors = rows.map((r) => ({ ...r, actor: r.actorId ? (actorMap.get(r.actorId) ?? null) : null }));

  res.json({ success: true, data: { rows: rowsWithActors, total, page: parseInt(page) } });
});

export default router;
