import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';

const router = Router();
router.use(authenticate);

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function parseDateOnly(s: string): Date {
  return new Date(`${s}T12:00:00.000Z`);
}

const CreateTimesheetSchema = z.object({
  ticketId: z.string().uuid().optional().nullable(),
  date: dateStr,
  hours: z.number().positive().max(24),
  description: z.string().optional().nullable(),
});

const UpdateTimesheetSchema = CreateTimesheetSchema.partial();

function canReadUserTimesheets(req: AuthRequest, targetUserId: string) {
  if (targetUserId === req.user!.id) return true;
  return req.user!.roles.includes('admin') || req.user!.permissions.includes('users:read');
}

// GET /api/timesheets?from=YYYY-MM-DD&to=YYYY-MM-DD&userId=
router.get('/', async (req: AuthRequest, res) => {
  const { from, to, userId: qUserId } = req.query as Record<string, string | undefined>;
  const targetUserId = qUserId || req.user!.id;

  if (!canReadUserTimesheets(req, targetUserId)) {
    throw new AppError(403, 'Cannot view this user\'s timesheets', 'FORBIDDEN');
  }

  const where: any = { userId: targetUserId };
  if (from || to) {
    where.date = {};
    if (from) where.date.gte = parseDateOnly(from);
    if (to) where.date.lte = parseDateOnly(to);
  }

  const entries = await prisma.timesheet.findMany({
    where,
    include: {
      ticket: {
        select: {
          id: true,
          title: true,
          project: { select: { id: true, key: true, name: true } },
        },
      },
    },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    take: 500,
  });

  res.json({ success: true, data: { entries } });
});

// POST /api/timesheets
router.post('/', async (req: AuthRequest, res) => {
  const body = CreateTimesheetSchema.parse(req.body);

  const entry = await prisma.timesheet.create({
    data: {
      userId: req.user!.id,
      ticketId: body.ticketId ?? undefined,
      date: parseDateOnly(body.date),
      hours: body.hours,
      description: body.description ?? undefined,
    },
    include: {
      ticket: {
        select: {
          id: true,
          title: true,
          project: { select: { id: true, key: true, name: true } },
        },
      },
    },
  });

  res.status(201).json({ success: true, data: entry });
});

// PATCH /api/timesheets/:id
router.patch('/:id', async (req: AuthRequest, res) => {
  const body = UpdateTimesheetSchema.parse(req.body);

  const existing = await prisma.timesheet.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new AppError(404, 'Timesheet not found', 'NOT_FOUND');
  if (existing.userId !== req.user!.id && !req.user!.roles.includes('admin')) {
    throw new AppError(403, 'Cannot edit this entry', 'FORBIDDEN');
  }

  const entry = await prisma.timesheet.update({
    where: { id: req.params.id },
    data: {
      ...(body.ticketId !== undefined && { ticketId: body.ticketId }),
      ...(body.date !== undefined && { date: parseDateOnly(body.date) }),
      ...(body.hours !== undefined && { hours: body.hours }),
      ...(body.description !== undefined && { description: body.description ?? undefined }),
    },
    include: {
      ticket: {
        select: {
          id: true,
          title: true,
          project: { select: { id: true, key: true, name: true } },
        },
      },
    },
  });

  res.json({ success: true, data: entry });
});

// DELETE /api/timesheets/:id
router.delete('/:id', async (req: AuthRequest, res) => {
  const existing = await prisma.timesheet.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new AppError(404, 'Timesheet not found', 'NOT_FOUND');
  if (existing.userId !== req.user!.id && !req.user!.roles.includes('admin')) {
    throw new AppError(403, 'Cannot delete this entry', 'FORBIDDEN');
  }

  await prisma.timesheet.delete({ where: { id: req.params.id } });
  res.json({ success: true, message: 'Deleted' });
});

export default router;
