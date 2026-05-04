import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { authenticate, AuthRequest, requireRole } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';

const router = Router();
router.use(authenticate);

const UpsertOrgSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/i, 'Slug: letters, numbers, hyphens only'),
  logo: z.string().max(2048).optional(),
  description: z.string().max(2000).optional(),
  website: z.string().url().optional().or(z.literal('')),
});

const MemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(['owner', 'admin', 'member']).optional(),
});

router.get('/', requireRole('admin', 'project_manager'), async (_req, res) => {
  const orgs = await prisma.organisation.findMany({
    orderBy: { name: 'asc' },
    include: {
      _count: { select: { companies: true, members: true } },
    },
  });
  res.json({ success: true, data: orgs });
});

router.post('/', requireRole('admin'), async (req: AuthRequest, res) => {
  const data = UpsertOrgSchema.parse(req.body);
  const exists = await prisma.organisation.findUnique({ where: { slug: data.slug.toLowerCase() } });
  if (exists) throw new AppError(409, 'Organisation slug already in use', 'DUPLICATE_SLUG');

  const org = await prisma.organisation.create({
    data: {
      ...data,
      slug: data.slug.toLowerCase(),
      website: data.website || undefined,
      members: {
        create: [{ userId: req.user!.id, role: 'owner' }],
      },
    },
  });
  res.status(201).json({ success: true, data: org });
});

router.get('/:id', requireRole('admin', 'project_manager'), async (req, res) => {
  const org = await prisma.organisation.findFirst({
    where: { id: req.params.id },
    include: {
      companies: {
        where: { deletedAt: null },
        orderBy: { name: 'asc' },
      },
      members: {
        include: { user: { select: { id: true, email: true, firstName: true, lastName: true, avatar: true } } },
      },
    },
  });
  if (!org) throw new AppError(404, 'Organisation not found', 'NOT_FOUND');
  res.json({ success: true, data: org });
});

router.patch('/:id', requireRole('admin'), async (req, res) => {
  const data = UpsertOrgSchema.partial().parse(req.body);
  const slug = data.slug?.toLowerCase();

  const org = await prisma.organisation.findUnique({ where: { id: req.params.id } });
  if (!org) throw new AppError(404, 'Organisation not found', 'NOT_FOUND');

  if (slug && slug !== org.slug) {
    const taken = await prisma.organisation.findFirst({ where: { slug, NOT: { id: org.id } } });
    if (taken) throw new AppError(409, 'Slug taken', 'DUPLICATE_SLUG');
  }

  const updated = await prisma.organisation.update({
    where: { id: req.params.id },
    data: {
      ...data,
      ...(slug !== undefined ? { slug } : {}),
      website: data.website === '' ? undefined : data.website,
    },
  });
  res.json({ success: true, data: updated });
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  const org = await prisma.organisation.findUnique({
    where: { id: req.params.id },
    include: { _count: { select: { companies: true } } },
  });
  if (!org) throw new AppError(404, 'Organisation not found', 'NOT_FOUND');
  if (org._count.companies > 0) {
    throw new AppError(400, 'Delete companies first or reassign projects', 'ORG_HAS_COMPANIES');
  }
  await prisma.organisationMember.deleteMany({ where: { organisationId: org.id } });
  await prisma.organisation.delete({ where: { id: org.id } });
  res.json({ success: true, message: 'Organisation deleted' });
});

router.post('/:id/members', requireRole('admin'), async (req, res) => {
  const body = MemberSchema.parse(req.body);
  const role = body.role ?? 'member';

  const org = await prisma.organisation.findUnique({ where: { id: req.params.id } });
  if (!org) throw new AppError(404, 'Organisation not found', 'NOT_FOUND');

  const userOk = await prisma.user.findFirst({ where: { id: body.userId, deletedAt: null } });
  if (!userOk) throw new AppError(404, 'User not found', 'NOT_FOUND');

  await prisma.organisationMember.upsert({
    where: {
      organisationId_userId: { organisationId: org.id, userId: body.userId },
    },
    create: { organisationId: org.id, userId: body.userId, role },
    update: { role },
  });

  const members = await prisma.organisationMember.findMany({
    where: { organisationId: org.id },
    include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
  });
  res.json({ success: true, data: members });
});

router.delete('/:orgId/members/:userId', requireRole('admin'), async (req, res) => {
  await prisma.organisationMember.deleteMany({
    where: { organisationId: req.params.orgId, userId: req.params.userId },
  });
  res.json({ success: true, message: 'Member removed' });
});

export default router;
