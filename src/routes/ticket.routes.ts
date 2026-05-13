import { Router } from 'express';
import path from 'path';
import { randomUUID } from 'crypto';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { authenticate, requirePermission, requireRole, AuthRequest } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { applyTicketParticipantScope } from '../utils/ticket-access';
import type { Prisma, TicketPriority, TicketType } from '@prisma/client';
import { redmineScraper } from '../services/redmine-scraper.service';
import { massScraper } from '../services/mass-scraper.service';
import {
  notifyTicketComment,
  notifyTicketCreated,
  notifyTicketUpdated,
} from '../services/ticket-notification.service';
import { config } from '../utils/config';
import {
  dedupeTicketsByLegacyKey,
  remediateLegacyCodemagenTickets,
} from '../services/legacy-ticket-remediation.service';
import { legacyPatchFromConverted, performLegacyCodemagenSync } from '../services/legacy-sync.service';
import { enqueueLegacySyncJobs } from '../queues/index';
import {
  applyCodemagenTicketVisibility,
  applyCodemagenUserVisibility,
  assertCodemagenEnabled,
  filterVisibleUsers,
  getTicketCompanyLabel,
  getCodemagenEnabled,
} from '../utils/system-settings';
import { emitBoardEvent } from '../services/board-events.service';
import { getInitialBoardOrder, transitionTicketWorkflow } from '../services/ticket-transition.service';

const router = Router();
router.use(authenticate);

const ticketUploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, config.upload.dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, `ticket_${randomUUID()}${ext}`);
  },
});
const ticketUpload = multer({
  storage: ticketUploadStorage,
  limits: { fileSize: config.upload.maxSizeMb * 1024 * 1024 },
});

function budgetHoursForPriority(priority: string): number {
  if (priority === 'CRITICAL') return 24;
  if (priority === 'HIGH') return 72;
  if (priority === 'MEDIUM') return 168;
  return 336;
}

function slaForTicket(t: { priority: string; dueDate: Date | null; createdAt: Date }) {
  const budgetHours = budgetHoursForPriority(t.priority);
  const deadline = t.dueDate ?? new Date(t.createdAt.getTime() + budgetHours * 3600 * 1000);
  const nowMs = Date.now();
  const remainingMs = deadline.getTime() - nowMs;
  const breached = remainingMs < 0;
  const atRisk = !breached && remainingMs < budgetHours * 3600 * 1000 * 0.25;
  return {
    budgetHours,
    deadline: deadline.toISOString(),
    status: breached ? ('breached' as const) : atRisk ? ('at_risk' as const) : ('on_track' as const),
  };
}

const MASS_SYNC_STALE_MINUTES = 10;
/** Hard cap for GET /api/tickets page size — large payloads; prefer filters + paging when possible */
const TICKET_LIST_MAX_LIMIT = 25_000;

async function getProjectCompanyId(projectId: string): Promise<string | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { companyId: true },
  });
  return project?.companyId ?? null;
}

async function failStaleMassSyncJobs(): Promise<void> {
  const cutoff = new Date(Date.now() - MASS_SYNC_STALE_MINUTES * 60 * 1000);
  await prisma.externalSyncJob.updateMany({
    where: {
      status: { in: ['PENDING', 'PROCESSING'] },
      updatedAt: { lt: cutoff },
    },
    data: {
      status: 'FAILED',
      error: `Marked failed automatically: no progress for ${MASS_SYNC_STALE_MINUTES}+ minutes`,
      completedAt: new Date(),
    },
  });
}

const TicketSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  type: z.enum(['TASK', 'BUG', 'STORY', 'EPIC', 'SUBTASK']).default('TASK'),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  assigneeIds: z.array(z.string().min(1)).optional(),
  sprintId: z.string().uuid().optional(),
  storyPoints: z.number().optional(),
  estimatedHours: z.number().optional(),
  dueDate: z.coerce.date().optional(),
  module: z.string().optional(),
  screen: z.string().optional(),
  tags: z.array(z.string()).default([]),
  parentId: z.string().uuid().optional(),
  workflowStateId: z.string().min(1).optional(),
  companyId: z.union([z.string().uuid(), z.null()]).optional(),
});

// POST /api/tickets/sync-external
router.post('/sync-external', requirePermission('tickets', 'update'), async (req, res) => {
  await assertCodemagenEnabled('start external Codemagen sync');
  const { projectId } = req.body as { projectId?: string };
  
  const where: any = { sourceUrl: { not: null }, deletedAt: null };
  if (projectId) where.projectId = projectId;

  const tickets = await prisma.ticket.findMany({
    where,
    select: { id: true, sourceUrl: true }
  });

  // Start background sync
  (async () => {
    let success = 0;
    let failed = 0;
    for (const ticket of tickets) {
      if (!ticket.sourceUrl?.includes('codemagen.net')) continue;
      
      try {
        const metadata = await redmineScraper.scrapeIssue(ticket.sourceUrl);
        const converted = (metadata.converted || {}) as Record<string, unknown>;
        const legacyApply = legacyPatchFromConverted(converted);
        await prisma.ticket.update({
          where: { id: ticket.id },
          data: {
            metadata: metadata as any,
            ...legacyApply,
          },
        });
        success++;
      } catch (err) {
        failed++;
      }
    }
  })();

  res.json({ success: true, message: `Started syncing external data for ${tickets.length} tickets.` });
});

// POST /api/tickets/mass-sync
router.post('/mass-sync', requirePermission('tickets', 'create'), async (req: AuthRequest, res) => {
  await assertCodemagenEnabled('start Codemagen extraction');
  const { projectId, startId, endId } = req.body;

  if (!projectId || !startId || !endId) {
    return res.status(400).json({ error: { message: 'projectId, startId, and endId are required' } });
  }

  await failStaleMassSyncJobs();

  const activeJob = await prisma.externalSyncJob.findFirst({
    where: { status: { in: ['PENDING', 'PROCESSING'] } },
    orderBy: { createdAt: 'desc' },
  });
  if (activeJob) {
    // Re-trigger worker in case process restarted and in-memory loop was lost.
    void massScraper.startSyncJob(activeJob.id);
    return res.status(409).json({
      success: false,
      error: {
        code: 'SYNC_JOB_ACTIVE',
        message: `A sync job is already active (#${activeJob.currentId}/${activeJob.endId}). Please wait or retry after it updates.`,
      },
      data: activeJob,
    });
  }

  const job = await prisma.externalSyncJob.create({
    data: {
      projectId,
      startId: parseInt(startId),
      endId: parseInt(endId),
      currentId: parseInt(startId),
      totalCount: parseInt(endId) - parseInt(startId) + 1,
      status: 'PENDING'
    }
  });

  // Start in background
  massScraper.startSyncJob(job.id);

  res.json({ success: true, data: job });
});

// GET /api/tickets/mass-sync/status
router.get('/mass-sync/status', requirePermission('tickets', 'read'), async (req: AuthRequest, res) => {
  await failStaleMassSyncJobs();

  const job =
    (await prisma.externalSyncJob.findFirst({
      where: { status: { in: ['PENDING', 'PROCESSING'] } },
      orderBy: { createdAt: 'desc' },
    })) ??
    (await prisma.externalSyncJob.findFirst({
      orderBy: { createdAt: 'desc' },
    }));

  if (job && (job.status === 'PENDING' || job.status === 'PROCESSING')) {
    void massScraper.startSyncJob(job.id);
  }

  res.json({ success: true, data: job });
});

// GET /api/tickets
router.get('/', requirePermission('tickets', 'read'), async (req: AuthRequest, res) => {
  const {
    projectId,
    sprintId,
    assigneeIds,
    assigneeId,
    status,
    type,
    priority,
    search,
    page = '1',
    limit = '50',
    team,
    companyId,
    organisationId,
    sort,
  } = req.query as Record<string, string>;
  const limitNum = parseInt(String(limit), 10);
  const take = Math.min(Math.max(Number.isFinite(limitNum) ? limitNum : 50, 1), TICKET_LIST_MAX_LIMIT);
  const pageNum = Math.max(parseInt(String(page), 10) || 1, 1);
  const skip = (pageNum - 1) * take;
  const codemagenEnabled = await getCodemagenEnabled();

  const where: Prisma.TicketWhereInput = { deletedAt: null };
  applyCodemagenTicketVisibility(where, codemagenEnabled);
  if (projectId) where.projectId = projectId;
  if (sprintId) where.sprintId = sprintId;
  if (type) where.type = type as TicketType;
  if (priority) where.priority = priority as TicketPriority;
  if (search) where.title = { contains: search, mode: 'insensitive' };
  if (status) where.workflowState = { slug: status };
  if (companyId) where.companyId = companyId;
  if (organisationId) where.company = { organisationId };

  const assigneeIdList =
    assigneeIds && assigneeIds.length > 0
      ? assigneeIds.split(',').filter(Boolean)
      : assigneeId && assigneeId.trim().length > 0
        ? [assigneeId.trim()]
        : [];

  const filterAnd: Prisma.TicketWhereInput[] = [];

  if (assigneeIdList.length > 0) {
    filterAnd.push({ assignees: { some: { id: { in: assigneeIdList } } } });
  }

  if (team && team !== 'ALL' && req.query.mine !== 'true') {
    if (team === 'hanz') {
      filterAnd.push({
        assignees: { some: { department: 'Hanz' }, every: { department: 'Hanz' } },
      });
    } else if (team === 'codemagen') {
      filterAnd.push({
        assignees: { some: { department: 'Codemagen' }, every: { department: 'Codemagen' } },
      });
    } else if (team === 'common') {
      filterAnd.push({
        AND: [
          { assignees: { some: { department: 'Hanz' } } },
          { assignees: { some: { department: 'Codemagen' } } },
        ],
      });
    }
  }

  if (req.query.mine === 'true') {
    filterAnd.push({ assignees: { some: { id: req.user!.id } } });
  }

  if (filterAnd.length > 0) {
    const prevAnd = where.AND;
    where.AND =
      prevAnd === undefined ? filterAnd : Array.isArray(prevAnd) ? [...prevAnd, ...filterAnd] : [prevAnd, ...filterAnd];
  }

  applyTicketParticipantScope(where, req.user!.id, req.user!.roles);

  const orderBy: Prisma.TicketOrderByWithRelationInput[] =
    sort === 'legacy' ?
      [
        {
          legacyIssueNumber: 'asc',
        },
        { createdAt: 'desc' },
      ]
    : [{ createdAt: 'desc' }];

  const [tickets, total] = await prisma.$transaction([
    prisma.ticket.findMany({
      where,
      include: {
        assignees: { select: { id: true, firstName: true, lastName: true, avatar: true, department: true } },
        reporter: { select: { id: true, firstName: true, lastName: true } },
        workflowState: true,
        project: {
          select: {
            id: true,
            name: true,
            key: true,
            company: { select: { id: true, name: true, organisationId: true } },
          },
        },
        company: { select: { id: true, name: true, organisationId: true } },
        _count: { select: { comments: true, attachments: true, children: true } },
      },
      orderBy,
      skip,
      take,
    }),
    prisma.ticket.count({ where }),
  ]);

  res.json({
    success: true,
    data: {
      tickets: tickets.map((ticket) => ({
        ...ticket,
        assignees: filterVisibleUsers(ticket.assignees, codemagenEnabled),
        companyLabel: getTicketCompanyLabel(ticket),
      })),
      total,
      page: pageNum,
      limit: take,
    },
  });
});

/** Who can be assigned — all active users + projectMemberIds highlights project roster. */
router.get('/assignment-candidates', requirePermission('tickets', 'read'), async (req: AuthRequest, res) => {
  const codemagenEnabled = await getCodemagenEnabled();
  const ticketIdRaw = req.query.ticketId;
  const projectIdRaw = req.query.projectId;
  const ticketId =
    typeof ticketIdRaw === 'string' && ticketIdRaw.trim().length > 0 ? ticketIdRaw.trim() : undefined;
  const projectIdOnly =
    typeof projectIdRaw === 'string' && projectIdRaw.trim().length > 0 ? z.string().uuid().parse(projectIdRaw.trim()) : undefined;

  if (!ticketId && !projectIdOnly) {
    throw new AppError(400, 'Query parameter ticketId or projectId is required', 'BAD_REQUEST');
  }
  if (ticketId && projectIdOnly) {
    throw new AppError(400, 'Provide only one of ticketId or projectId', 'BAD_REQUEST');
  }

  let projectIdForMembers: string;

  if (ticketId) {
    const ticketLookup: Prisma.TicketWhereInput = { id: ticketId, deletedAt: null };
    applyTicketParticipantScope(ticketLookup, req.user!.id, req.user!.roles);

    const ticket = await prisma.ticket.findFirst({
      where: ticketLookup,
      select: { id: true, projectId: true },
    });
    if (!ticket) throw new AppError(404, 'Ticket not found', 'NOT_FOUND');
    projectIdForMembers = ticket.projectId;
  } else {
    const projectWhere: Prisma.ProjectWhereInput = { id: projectIdOnly!, deletedAt: null };
    if (!req.user!.roles.includes('admin') && !req.user!.roles.includes('project_manager')) {
      projectWhere.members = { some: { userId: req.user!.id } };
    }
    const projectOk = await prisma.project.findFirst({ where: projectWhere, select: { id: true } });
    if (!projectOk) throw new AppError(404, 'Project not found', 'NOT_FOUND');
    projectIdForMembers = projectOk.id;
  }

  const memberRows = await prisma.projectMember.findMany({
    where: { projectId: projectIdForMembers },
    select: { userId: true },
  });
  const projectMemberIds = new Set(memberRows.map((r) => r.userId));

  const candidateWhere: Prisma.UserWhereInput = { deletedAt: null, status: 'ACTIVE' };
  applyCodemagenUserVisibility(candidateWhere, codemagenEnabled);

  const all = await prisma.user.findMany({
    where: candidateWhere,
    select: { id: true, firstName: true, lastName: true, email: true, avatar: true },
    orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    take: 1000,
  });

  let users = all.map((u) => ({
    id: u.id,
    firstName: u.firstName,
    lastName: u.lastName,
    email: u.email,
    avatar: u.avatar ?? undefined,
  }));

  // Project members listed first so they are visible without scrolling
  users.sort((a, b) => {
    const am = projectMemberIds.has(a.id) ? 0 : 1;
    const bm = projectMemberIds.has(b.id) ? 0 : 1;
    if (am !== bm) return am - bm;
    return `${a.firstName} ${a.lastName ?? ''}`.localeCompare(`${b.firstName} ${b.lastName ?? ''}`);
  });

  const memberIds = [...projectMemberIds];

  res.json({
    success: true,
    data: {
      users,
      memberIds,
      source: memberIds.length > 0 ? 'all_active_with_project_members' : 'all_active',
    },
  });
});

/** Typical module/screen/tag/title values for datalist suggestions in the UI. */
router.get('/form-suggestions', requirePermission('tickets', 'read'), async (req: AuthRequest, res) => {
  const codemagenEnabled = await getCodemagenEnabled();
  const projectIdRaw = req.query.projectId;
  const projectId =
    typeof projectIdRaw === 'string' && projectIdRaw.trim().length > 0 ? projectIdRaw.trim() : undefined;

  const baseWhere: Prisma.TicketWhereInput = { deletedAt: null };
  applyCodemagenTicketVisibility(baseWhere, codemagenEnabled);
  if (projectId) baseWhere.projectId = projectId;

  const [withModule, withScreen, titleRows, tagRows] = await Promise.all([
    prisma.ticket.findMany({
      where: { ...baseWhere, module: { not: null } },
      distinct: ['module'],
      select: { module: true },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    }),
    prisma.ticket.findMany({
      where: { ...baseWhere, screen: { not: null } },
      distinct: ['screen'],
      select: { screen: true },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    }),
    prisma.ticket.findMany({
      where: baseWhere,
      select: { title: true },
      orderBy: { updatedAt: 'desc' },
      take: 30,
    }),
    prisma.ticket.findMany({
      where: { ...baseWhere, tags: { isEmpty: false } },
      select: { tags: true },
      take: 250,
    }),
  ]);

  const modules = [...new Set(withModule.map((r) => r.module).filter((m): m is string => !!m?.trim()))]
    .sort()
    .slice(0, 40);
  const screens = [...new Set(withScreen.map((r) => r.screen).filter((s): s is string => !!s?.trim()))]
    .sort()
    .slice(0, 40);
  const recentTitles = [...new Set(titleRows.map((t) => t.title).filter(Boolean))].slice(0, 25);

  const tagSet = new Set<string>();
  for (const row of tagRows) {
    for (const t of row.tags) {
      const v = typeof t === 'string' ? t.trim() : '';
      if (v) tagSet.add(v);
    }
  }
  const tags = [...tagSet].sort((a, b) => a.localeCompare(b)).slice(0, 50);

  res.json({
    success: true,
    data: {
      modules,
      screens,
      tags,
      recentTitles,
    },
  });
  });

/** Dropdown data for ticket list filters (accessible with tickets:read). */
router.get('/filter-options', requirePermission('tickets', 'read'), async (_req: AuthRequest, res) => {
  const codemagenEnabled = await getCodemagenEnabled();
  const activeUserWhere: Prisma.UserWhereInput = { deletedAt: null, status: 'ACTIVE' };
  applyCodemagenUserVisibility(activeUserWhere, codemagenEnabled);
  const [projects, companies, organisations, activeUsers] = await Promise.all([
    prisma.project.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, key: true, companyId: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
    prisma.company.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, organisationId: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
    prisma.organisation.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 200,
    }),
    prisma.user.findMany({
      where: activeUserWhere,
      select: { id: true, firstName: true, lastName: true, email: true },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      take: 800,
    }),
  ]);
  res.json({ success: true, data: { projects, companies, organisations, users: activeUsers, codemagenEnabled } });
});

router.get('/ticket-templates', requirePermission('tickets', 'read'), async (req: AuthRequest, res) => {
  const pid = typeof req.query.projectId === 'string' && req.query.projectId ? req.query.projectId : undefined;
  const templates = await prisma.ticketTemplate.findMany({
    where: pid ? { projectId: pid } : {},
    orderBy: { name: 'asc' },
    take: 200,
  });
  res.json({ success: true, data: templates });
});

router.post('/ticket-templates', requirePermission('tickets', 'create'), async (req, res) => {
  const body = z
    .object({
      projectId: z.string().uuid(),
      name: z.string().min(1).max(200),
      fields: z.record(z.unknown()),
      scheduleCron: z.string().optional(),
    })
    .parse(req.body);
  const row = await prisma.ticketTemplate.create({
    data: {
      projectId: body.projectId,
      name: body.name,
      fields: body.fields as object,
      scheduleCron: body.scheduleCron,
    },
  });
  res.status(201).json({ success: true, data: row });
});

router.post(
  '/instantiate-from-template/:templateId',
  requirePermission('tickets', 'create'),
  async (req: AuthRequest, res) => {
    const tpl = await prisma.ticketTemplate.findUnique({ where: { id: req.params.templateId } });
    if (!tpl) throw new AppError(404, 'Template not found', 'NOT_FOUND');
    const f = tpl.fields as Record<string, unknown>;
    const title = typeof f.title === 'string' && f.title ? f.title : `From template: ${tpl.name}`;
    const description = typeof f.description === 'string' ? f.description : undefined;
    const rawType = f.type ?? 'TASK';
    const type =
      typeof rawType === 'string' && ['TASK', 'BUG', 'STORY', 'EPIC', 'SUBTASK'].includes(rawType)
        ? (rawType as 'TASK' | 'BUG' | 'STORY' | 'EPIC' | 'SUBTASK')
        : 'TASK';
    const rawPri = f.priority ?? 'MEDIUM';
    const priority =
      typeof rawPri === 'string' && ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(rawPri)
        ? (rawPri as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL')
        : 'MEDIUM';

    const [defaultState, projectCompanyId] = await Promise.all([
      prisma.workflowState.findFirst({
        where: { projectId: tpl.projectId, isDefault: true },
      }),
      getProjectCompanyId(tpl.projectId),
    ]);

    const ticket = await prisma.ticket.create({
      data: {
        projectId: tpl.projectId,
        companyId: projectCompanyId ?? undefined,
        title,
        description,
        type,
        priority,
        tags: Array.isArray(f.tags) ? (f.tags as string[]) : [],
        module: typeof f.module === 'string' ? f.module : undefined,
        screen: typeof f.screen === 'string' ? f.screen : undefined,
        reporterId: req.user!.id,
        workflowStateId: defaultState?.id,
      },
    });
    await prisma.ticketHistory.create({
      data: { ticketId: ticket.id, actorId: req.user!.id, field: 'created', newValue: 'from template' },
    });
    void notifyTicketCreated(ticket.id, req.user!.id);
    res.status(201).json({ success: true, data: ticket });
  },
);

// POST /api/tickets/admin-remediate-legacy — move Codemagen/sheet rows + backfill keys (admin)
router.post('/admin-remediate-legacy', requireRole('admin'), async (req, res) => {
  await assertCodemagenEnabled('run legacy remediation');
  const body = z
    .object({
      targetProjectKey: z.string().min(1).default('EEP'),
      dryRun: z.boolean().optional(),
    })
    .parse(req.body ?? {});
  try {
    const data = await remediateLegacyCodemagenTickets({
      targetProjectKey: body.targetProjectKey,
      dryRun: body.dryRun,
    });
    res.json({ success: true, data });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '';
    if (msg.startsWith('PROJECT_NOT_FOUND')) {
      throw new AppError(404, 'Target project not found', 'NOT_FOUND');
    }
    throw e;
  }
});

// POST /api/tickets/admin-dedupe-legacy — collapse duplicate legacySourceKey rows (admin)
router.post('/admin-dedupe-legacy', requireRole('admin'), async (req, res) => {
  const body = z
    .object({
      preferProjectKey: z.string().min(1).optional(),
      dryRun: z.boolean().optional(),
    })
    .parse(req.body ?? {});
  const data = await dedupeTicketsByLegacyKey({
    preferProjectKey: body.preferProjectKey,
    dryRun: body.dryRun,
  });
  res.json({ success: true, data });
});

// POST /api/tickets/admin-enqueue-legacy-sync-all — queue Codemagen re-scrape for all eligible tickets (admin)
router.post('/admin-enqueue-legacy-sync-all', requireRole('admin'), async (req, res) => {
  await assertCodemagenEnabled('queue legacy refresh jobs');
  const body = z
    .object({
      limit: z.coerce.number().min(1).max(50_000).optional(),
    })
    .parse(req.body ?? {});
  const cap = body.limit ?? 10_000;

  const tickets = await prisma.ticket.findMany({
    where: {
      deletedAt: null,
      sourceUrl: { contains: 'codemagen', mode: 'insensitive' },
    },
    select: { id: true },
    take: cap,
    orderBy: { updatedAt: 'asc' },
  });

  const ids = tickets.map((t) => t.id);
  await enqueueLegacySyncJobs(ids);

  res.json({
    success: true,
    data: {
      enqueued: ids.length,
      queueName: 'legacy-sync-job',
      note: 'Jobs process asynchronously; check Admin → System queue metrics.',
    },
  });
});

// POST /api/tickets/:id/sync-legacy — re-scrape Redmine/Codemagen and merge metadata + core fields
router.post('/:id/sync-legacy', requirePermission('tickets', 'update'), async (req: AuthRequest, res) => {
  await assertCodemagenEnabled('refresh legacy ticket data');
  const whereLookup: Prisma.TicketWhereInput = { id: req.params.id, deletedAt: null };
  applyTicketParticipantScope(whereLookup, req.user!.id, req.user!.roles);
  const existing = await prisma.ticket.findFirst({
    where: whereLookup,
    select: { id: true, sourceUrl: true },
  });
  if (!existing?.sourceUrl) {
    throw new AppError(400, 'Ticket has no legacy source URL to sync', 'BAD_REQUEST');
  }
  if (!existing.sourceUrl.includes('codemagen')) {
    throw new AppError(400, 'Legacy sync only supports Codemagen/Redmine URLs', 'BAD_REQUEST');
  }

  await performLegacyCodemagenSync(existing.id);

  res.json({ success: true, message: 'Legacy data refreshed' });
});

// GET /api/tickets/:id
router.get('/:id', requirePermission('tickets', 'read'), async (req: AuthRequest, res) => {
  const codemagenEnabled = await getCodemagenEnabled();
  const whereTicket: Prisma.TicketWhereInput = { id: req.params.id, deletedAt: null };
  applyCodemagenTicketVisibility(whereTicket, codemagenEnabled);
  applyTicketParticipantScope(whereTicket, req.user!.id, req.user!.roles);

  const ticket = await prisma.ticket.findFirst({
    where: whereTicket,
    include: {
      assignees: {
        select: { id: true, firstName: true, lastName: true, avatar: true, email: true, department: true },
      },
      reporter: { select: { id: true, firstName: true, lastName: true } },
      workflowState: true,
      project: {
        select: {
          id: true,
          name: true,
          key: true,
          company: { select: { id: true, name: true, organisationId: true } },
        },
      },
      company: { select: { id: true, name: true, organisationId: true } },
      sprint: { select: { id: true, name: true, status: true } },
      comments: {
        where: { deletedAt: null },
        include: { author: { select: { id: true, firstName: true, lastName: true, avatar: true } } },
        orderBy: { createdAt: 'asc' },
      },
      attachments: true,
      history: { orderBy: { createdAt: 'desc' }, take: 50 },
      statusDurations: true,
      children: {
        include: {
          workflowState: true,
          assignees: { select: { id: true, firstName: true, lastName: true, department: true } },
        },
      },
      checklistItems: { orderBy: { sortOrder: 'asc' } },
      linksFrom: {
        include: { linkedTicket: { select: { id: true, title: true, type: true } } },
      },
      watchers: {
        include: {
          user: { select: { id: true, firstName: true, lastName: true, email: true, avatar: true, department: true } },
        },
      },
      _count: { select: { votes: true } },
    },
  });

  if (!ticket) throw new AppError(404, 'Ticket not found', 'NOT_FOUND');
  const sla = slaForTicket({
    priority: ticket.priority,
    dueDate: ticket.dueDate,
    createdAt: ticket.createdAt,
  });
  res.json({
    success: true,
    data: {
      ...ticket,
      assignees: filterVisibleUsers(ticket.assignees, codemagenEnabled),
      children: ticket.children.map((child) => ({
        ...child,
        assignees: filterVisibleUsers(child.assignees, codemagenEnabled),
      })),
      watchers: ticket.watchers.filter((watcher) => !watcher.user || filterVisibleUsers([watcher.user], codemagenEnabled).length > 0),
      companyLabel: getTicketCompanyLabel(ticket),
      sla,
    },
  });
});

// POST /api/tickets
router.post('/', requirePermission('tickets', 'create'), async (req: AuthRequest, res) => {
  const { assigneeIds, ...data } = TicketSchema.parse(req.body);

  const [defaultState, projectCompanyId] = await Promise.all([
    prisma.workflowState.findFirst({
      where: { projectId: data.projectId, isDefault: true },
    }),
    data.companyId === undefined ? getProjectCompanyId(data.projectId) : Promise.resolve(null),
  ]);

  const ticket = await prisma.ticket.create({
    data: {
      ...data,
      reporterId: req.user!.id,
      workflowStateId: defaultState?.id,
      boardOrder: defaultState ? await getInitialBoardOrder(data.projectId, defaultState.id) : 0,
      companyId: data.companyId === undefined ? projectCompanyId ?? undefined : data.companyId,
      assignees: assigneeIds ? { connect: assigneeIds.map(id => ({ id })) } : undefined,
    },
  });

  // Log history
  await prisma.ticketHistory.create({
    data: { ticketId: ticket.id, actorId: req.user!.id, field: 'created', newValue: 'ticket created' },
  });
  if (ticket.workflowStateId) {
    await prisma.ticketStatusDuration.create({
      data: { ticketId: ticket.id, status: ticket.workflowStateId, startedAt: new Date() },
    });
  }

  emitBoardEvent({
    type: 'ticket.created',
    projectId: ticket.projectId,
    ticketId: ticket.id,
    workflowStateId: ticket.workflowStateId,
    at: new Date().toISOString(),
  });

  void notifyTicketCreated(ticket.id, req.user!.id);

  res.status(201).json({ success: true, data: ticket });
});

// PATCH /api/tickets/:id
router.patch('/:id', requirePermission('tickets', 'update'), async (req: AuthRequest, res) => {
  const parsed = TicketSchema.partial().parse(req.body);
  const { assigneeIds, ...updates } = parsed;

  /** Prisma skips undefined fields; strip so we don't pass explicit undefined keys. */
  const cleanUpdates = Object.fromEntries(
    Object.entries(updates).filter(([, v]) => v !== undefined),
  ) as Record<string, unknown>;
  const requestedWorkflowStateId = typeof cleanUpdates.workflowStateId === 'string' ? cleanUpdates.workflowStateId : undefined;
  if (requestedWorkflowStateId) delete cleanUpdates.workflowStateId;

  const patchWhere: Prisma.TicketWhereInput = { id: req.params.id, deletedAt: null };
  applyTicketParticipantScope(patchWhere, req.user!.id, req.user!.roles);

  const existing = await prisma.ticket.findFirst({
    where: patchWhere,
    include: {
      assignees: { select: { id: true } },
      workflowState: { select: { id: true, name: true } },
    },
  });
  if (!existing) throw new AppError(404, 'Ticket not found', 'NOT_FOUND');

  const ticket = await prisma.ticket.update({
    where: { id: req.params.id },
    data: {
      ...(cleanUpdates as any),
      ...(assigneeIds !== undefined && {
        assignees: { set: assigneeIds.map((aid) => ({ id: aid })) },
      }),
    },
  });

  // Log changes
  const historyEntries = Object.entries(cleanUpdates).map(([field, newValue]) => ({
    ticketId: ticket.id,
    actorId: req.user!.id,
    field,
    oldValue: String((existing as any)[field] ?? ''),
    newValue: String(newValue ?? ''),
  }));

  if (historyEntries.length) {
    await prisma.ticketHistory.createMany({ data: historyEntries });
  }

  if (assigneeIds !== undefined) {
    const [oldUsers, newUsers] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: existing.assignees.map((a) => a.id) } },
        select: { firstName: true, lastName: true },
      }),
      prisma.user.findMany({
        where: { id: { in: assigneeIds } },
        select: { firstName: true, lastName: true },
      }),
    ]);
    const fmtUser = (u: { firstName: string; lastName: string }) => `${u.firstName} ${u.lastName}`.trim();
    await prisma.ticketHistory.create({
      data: {
        ticketId: ticket.id,
        actorId: req.user!.id,
        field: 'assignees',
        oldValue: oldUsers.map(fmtUser).join(', ') || '—',
        newValue: newUsers.map(fmtUser).join(', ') || '—',
      },
    });
  }

  if (requestedWorkflowStateId && existing.workflowStateId !== requestedWorkflowStateId) {
    await transitionTicketWorkflow({
      ticketId: ticket.id,
      projectId: existing.projectId,
      actor: { id: req.user!.id, roles: req.user!.roles },
      workflowStateId: requestedWorkflowStateId,
    });
  } else {
    emitBoardEvent({
      type: 'ticket.updated',
      projectId: existing.projectId,
      ticketId: ticket.id,
      workflowStateId: existing.workflowStateId,
      at: new Date().toISOString(),
    });
  }

  void notifyTicketUpdated(
    { assignees: existing.assignees },
    ticket.id,
    { ...cleanUpdates, ...(requestedWorkflowStateId ? { workflowStateId: requestedWorkflowStateId } : {}) },
    req.user!.id,
    {
      assigneeIdsApplied: assigneeIds,
      previousWorkflowStateName: existing.workflowState?.name ?? null,
    },
  );

  res.json({ success: true, data: ticket });
});

// DELETE /api/tickets/:id
router.delete('/:id', requirePermission('tickets', 'delete'), async (req, res) => {
  await prisma.ticket.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
  res.json({ success: true, message: 'Ticket deleted' });
});

// POST /api/tickets/:id/comments
router.post('/:id/comments', requirePermission('tickets', 'update'), async (req: AuthRequest, res) => {
  const { body } = z.object({ body: z.string().min(1) }).parse(req.body);

  const commentLookup: Prisma.TicketWhereInput = { id: req.params.id, deletedAt: null };
  applyTicketParticipantScope(commentLookup, req.user!.id, req.user!.roles);
  const ticketOk = await prisma.ticket.findFirst({ where: commentLookup, select: { id: true } });
  if (!ticketOk) throw new AppError(404, 'Ticket not found', 'NOT_FOUND');

  const comment = await prisma.ticketComment.create({
    data: { ticketId: req.params.id, authorId: req.user!.id, body },
    include: { author: { select: { id: true, firstName: true, lastName: true, avatar: true } } },
  });
  void notifyTicketComment({ ticketId: req.params.id, actorId: req.user!.id, commentPreview: body });
  res.status(201).json({ success: true, data: comment });
});

router.post('/:id/watch', requirePermission('tickets', 'read'), async (req: AuthRequest, res) => {
  const lk: Prisma.TicketWhereInput = { id: req.params.id, deletedAt: null };
  applyTicketParticipantScope(lk, req.user!.id, req.user!.roles);
  const ok = await prisma.ticket.findFirst({ where: lk, select: { id: true } });
  if (!ok) throw new AppError(404, 'Ticket not found', 'NOT_FOUND');
  await prisma.ticketWatcher.upsert({
    where: {
      ticketId_userId: { ticketId: req.params.id, userId: req.user!.id },
    },
    create: { ticketId: req.params.id, userId: req.user!.id },
    update: {},
  });
  res.json({ success: true, message: 'Watching' });
});

router.delete('/:id/watch', requirePermission('tickets', 'read'), async (req: AuthRequest, res) => {
  await prisma.ticketWatcher.deleteMany({
    where: { ticketId: req.params.id, userId: req.user!.id },
  });
  res.json({ success: true, message: 'Unwatched' });
});

router.post('/:id/vote', requirePermission('tickets', 'update'), async (req: AuthRequest, res) => {
  const lk: Prisma.TicketWhereInput = { id: req.params.id, deletedAt: null };
  applyTicketParticipantScope(lk, req.user!.id, req.user!.roles);
  const ok = await prisma.ticket.findFirst({ where: lk, select: { id: true } });
  if (!ok) throw new AppError(404, 'Ticket not found', 'NOT_FOUND');
  await prisma.ticketVote.upsert({
    where: { ticketId_userId: { ticketId: req.params.id, userId: req.user!.id } },
    create: { ticketId: req.params.id, userId: req.user!.id },
    update: {},
  });
  const count = await prisma.ticketVote.count({ where: { ticketId: req.params.id } });
  res.json({ success: true, data: { voteCount: count } });
});

router.delete('/:id/vote', requirePermission('tickets', 'update'), async (req: AuthRequest, res) => {
  await prisma.ticketVote.deleteMany({
    where: { ticketId: req.params.id, userId: req.user!.id },
  });
  const count = await prisma.ticketVote.count({ where: { ticketId: req.params.id } });
  res.json({ success: true, data: { voteCount: count } });
});

const LinkType = z.enum(['blocks', 'blocked_by', 'duplicate', 'relates_to']);

router.post('/:id/links', requirePermission('tickets', 'update'), async (req: AuthRequest, res) => {
  const body = z
    .object({ linkedTicketId: z.string().uuid(), type: LinkType })
    .parse(req.body);

  const lk: Prisma.TicketWhereInput = { id: req.params.id, deletedAt: null };
  applyTicketParticipantScope(lk, req.user!.id, req.user!.roles);
  const ticket = await prisma.ticket.findFirst({ where: lk, select: { id: true } });
  if (!ticket) throw new AppError(404, 'Ticket not found', 'NOT_FOUND');
  if (body.linkedTicketId === req.params.id) throw new AppError(400, 'Cannot link ticket to itself', 'BAD_REQUEST');

  const linked = await prisma.ticket.findFirst({
    where: { id: body.linkedTicketId, deletedAt: null },
  });
  if (!linked) throw new AppError(404, 'Linked ticket not found', 'NOT_FOUND');

  const row = await prisma.ticketLink.create({
    data: {
      ticketId: req.params.id,
      linkedTicketId: body.linkedTicketId,
      type: body.type,
    },
  });
  res.status(201).json({ success: true, data: row });
});

router.delete('/:id/links/:linkId', requirePermission('tickets', 'update'), async (req: AuthRequest, res) => {
  await prisma.ticketLink.deleteMany({
    where: { id: req.params.linkId, ticketId: req.params.id },
  });
  res.json({ success: true, message: 'Link removed' });
});

router.post('/:id/checklist', requirePermission('tickets', 'update'), async (req: AuthRequest, res) => {
  z.object({ label: z.string().min(1) }).parse(req.body);
  const { label } = req.body as { label: string };
  const lk: Prisma.TicketWhereInput = { id: req.params.id, deletedAt: null };
  applyTicketParticipantScope(lk, req.user!.id, req.user!.roles);
  const ok = await prisma.ticket.findFirst({ where: lk, select: { id: true } });
  if (!ok) throw new AppError(404, 'Ticket not found', 'NOT_FOUND');
  const maxOrder = await prisma.ticketChecklistItem.aggregate({
    where: { ticketId: req.params.id },
    _max: { sortOrder: true },
  });
  const item = await prisma.ticketChecklistItem.create({
    data: {
      ticketId: req.params.id,
      label,
      sortOrder: (maxOrder._max.sortOrder ?? 0) + 1,
    },
  });
  res.status(201).json({ success: true, data: item });
});

router.patch('/:id/checklist/:itemId', requirePermission('tickets', 'update'), async (req: AuthRequest, res) => {
  const patch = z
    .object({ label: z.string().optional(), done: z.boolean().optional(), sortOrder: z.number().optional() })
    .parse(req.body);
  const lk: Prisma.TicketWhereInput = { id: req.params.id, deletedAt: null };
  applyTicketParticipantScope(lk, req.user!.id, req.user!.roles);
  const ok = await prisma.ticket.findFirst({ where: lk, select: { id: true } });
  if (!ok) throw new AppError(404, 'Ticket not found', 'NOT_FOUND');
  const updated = await prisma.ticketChecklistItem.updateMany({
    where: { id: req.params.itemId, ticketId: req.params.id },
    data: patch,
  });
  if (updated.count === 0) throw new AppError(404, 'Item not found', 'NOT_FOUND');
  const row = await prisma.ticketChecklistItem.findUnique({ where: { id: req.params.itemId } });
  res.json({ success: true, data: row });
});

router.delete('/:id/checklist/:itemId', requirePermission('tickets', 'update'), async (req: AuthRequest, res) => {
  await prisma.ticketChecklistItem.deleteMany({
    where: { id: req.params.itemId, ticketId: req.params.id },
  });
  res.json({ success: true, message: 'Checklist item removed' });
});

router.get('/:id/time-logs', requirePermission('tickets', 'read'), async (req: AuthRequest, res) => {
  const lk: Prisma.TicketWhereInput = { id: req.params.id, deletedAt: null };
  applyTicketParticipantScope(lk, req.user!.id, req.user!.roles);
  const ok = await prisma.ticket.findFirst({ where: lk, select: { id: true } });
  if (!ok) throw new AppError(404, 'Ticket not found', 'NOT_FOUND');
  const rows = await prisma.timesheet.findMany({
    where: { ticketId: req.params.id },
    orderBy: { date: 'desc' },
    take: 100,
    include: { user: { select: { id: true, firstName: true, lastName: true } } },
  });
  const total = rows.reduce((a, r) => a + r.hours, 0);
  res.json({ success: true, data: { entries: rows, totalHours: total } });
});

router.post('/:id/time-logs', requirePermission('tickets', 'update'), async (req: AuthRequest, res) => {
  const body = z.object({
    hours: z.number().positive(),
    description: z.string().optional(),
    date: z.coerce.date(),
  }).parse(req.body);
  const lk: Prisma.TicketWhereInput = { id: req.params.id, deletedAt: null };
  applyTicketParticipantScope(lk, req.user!.id, req.user!.roles);
  const ok = await prisma.ticket.findFirst({ where: lk, select: { id: true } });
  if (!ok) throw new AppError(404, 'Ticket not found', 'NOT_FOUND');

  const ts = await prisma.timesheet.create({
    data: {
      userId: req.user!.id,
      ticketId: req.params.id,
      hours: body.hours,
      description: body.description,
      date: body.date,
    },
    include: { user: { select: { id: true, firstName: true } } },
  });
  res.status(201).json({ success: true, data: ts });
});

router.post('/:id/clone', requirePermission('tickets', 'create'), async (req: AuthRequest, res) => {
  const lk: Prisma.TicketWhereInput = { id: req.params.id, deletedAt: null };
  applyTicketParticipantScope(lk, req.user!.id, req.user!.roles);
  const src = await prisma.ticket.findFirst({
    where: lk,
    include: {
      checklistItems: true,
    },
  });
  if (!src) throw new AppError(404, 'Ticket not found', 'NOT_FOUND');

  const defaultState = await prisma.workflowState.findFirst({
    where: { projectId: src.projectId, isDefault: true },
  });

  const copy = await prisma.ticket.create({
    data: {
      projectId: src.projectId,
      title: `[Copy] ${src.title}`,
      description: src.description,
      type: src.type,
      priority: src.priority,
      reporterId: req.user!.id,
      workflowStateId: defaultState?.id,
      storyPoints: src.storyPoints,
      module: src.module ?? undefined,
      screen: src.screen ?? undefined,
      tags: src.tags ?? [],
      sprintId: undefined,
      parentId: src.parentId,
    },
  });
  await prisma.ticketHistory.create({
    data: { ticketId: copy.id, actorId: req.user!.id, field: 'created', newValue: `cloned from ${src.id}` },
  });

  void notifyTicketCreated(copy.id, req.user!.id);

  res.status(201).json({ success: true, data: copy });
});

router.post(
  '/:id/attachments',
  requirePermission('tickets', 'update'),
  ticketUpload.single('file'),
  async (req: AuthRequest, res) => {
    if (!req.file) throw new AppError(400, 'No file uploaded', 'BAD_REQUEST');
    const lk: Prisma.TicketWhereInput = { id: req.params.id, deletedAt: null };
    applyTicketParticipantScope(lk, req.user!.id, req.user!.roles);
    const ok = await prisma.ticket.findFirst({ where: lk, select: { id: true } });
    if (!ok) throw new AppError(404, 'Ticket not found', 'NOT_FOUND');

    const publicUrl = `/uploads/${encodeURIComponent(req.file.filename)}`;
    const attach = await prisma.ticketAttachment.create({
      data: {
        ticketId: req.params.id,
        uploadedById: req.user!.id,
        filename: req.file.filename,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
        url: publicUrl,
      },
    });
    res.status(201).json({ success: true, data: attach });
  },
);

export default router;
