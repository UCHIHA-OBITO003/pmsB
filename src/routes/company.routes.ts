import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { authenticate, AuthRequest, requireRole } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';

const router = Router();
router.use(authenticate);

const UpsertCompanySchema = z.object({
  organisationId: z.string().uuid(),
  name: z.string().min(1).max(160),
  logo: z.string().max(2048).optional(),
  industry: z.string().max(120).optional(),
  description: z.string().max(4000).optional(),
  website: z.string().url().optional().or(z.literal('')),
});

const CompanyMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(['owner', 'manager', 'developer', 'qa', 'stakeholder']).optional(),
});

router.get('/', requireRole('admin', 'project_manager'), async (req, res) => {
  const organisationId = typeof req.query.organisationId === 'string' ? req.query.organisationId : undefined;

  const where: { deletedAt: null; organisationId?: string } = { deletedAt: null };
  if (organisationId) where.organisationId = organisationId;

  const companies = await prisma.company.findMany({
    where,
    orderBy: { name: 'asc' },
    include: {
      organisation: { select: { id: true, name: true, slug: true } },
      _count: { select: { projects: true, members: true } },
    },
  });
  res.json({ success: true, data: companies });
});

router.post('/', requireRole('admin'), async (req: AuthRequest, res) => {
  const body = UpsertCompanySchema.parse(req.body);

  const org = await prisma.organisation.findUnique({ where: { id: body.organisationId } });
  if (!org) throw new AppError(404, 'Organisation not found', 'NOT_FOUND');

  const company = await prisma.company.create({
    data: {
      organisationId: body.organisationId,
      name: body.name,
      logo: body.logo,
      industry: body.industry,
      description: body.description,
      website: body.website || undefined,
      members: {
        create: [{ userId: req.user!.id, role: 'owner' }],
      },
    },
  });
  res.status(201).json({ success: true, data: company });
});

router.get('/:id', requireRole('admin', 'project_manager'), async (req, res) => {
  const company = await prisma.company.findFirst({
    where: { id: req.params.id, deletedAt: null },
    include: {
      organisation: true,
      members: {
        include: { user: { select: { id: true, email: true, firstName: true, lastName: true, avatar: true, skills: true } } },
      },
      projects: {
        where: { deletedAt: null },
        select: { id: true, name: true, key: true, status: true },
      },
    },
  });
  if (!company) throw new AppError(404, 'Company not found', 'NOT_FOUND');
  res.json({ success: true, data: company });
});

router.patch('/:id', requireRole('admin'), async (req, res) => {
  const patch = UpsertCompanySchema.partial().omit({ organisationId: true }).parse(req.body);

  const company = await prisma.company.findFirst({
    where: { id: req.params.id, deletedAt: null },
  });
  if (!company) throw new AppError(404, 'Company not found', 'NOT_FOUND');

  const updated = await prisma.company.update({
    where: { id: company.id },
    data: {
      ...patch,
      website: patch.website === '' ? null : patch.website,
    },
  });
  res.json({ success: true, data: updated });
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  const company = await prisma.company.findFirst({
    where: { id: req.params.id, deletedAt: null },
    include: { _count: { select: { projects: true } } },
  });
  if (!company) throw new AppError(404, 'Company not found', 'NOT_FOUND');
  if (company._count.projects > 0) {
    await prisma.project.updateMany({ where: { companyId: company.id }, data: { companyId: null } });
  }
  await prisma.company.update({
    where: { id: company.id },
    data: { deletedAt: new Date() },
  });
  res.json({ success: true, message: 'Company archived' });
});

router.patch('/:id/projects/:projectId', requireRole('admin', 'project_manager'), async (req, res) => {
  const { id, projectId } = req.params;
  const company = await prisma.company.findFirst({ where: { id, deletedAt: null } });
  if (!company) throw new AppError(404, 'Company not found', 'NOT_FOUND');

  const proj = await prisma.project.findFirst({ where: { id: projectId, deletedAt: null } });
  if (!proj) throw new AppError(404, 'Project not found', 'NOT_FOUND');

  await prisma.project.update({
    where: { id: projectId },
    data: { companyId: company.id },
  });
  res.json({ success: true, message: 'Project linked to company' });
});

router.post('/:id/members', requireRole('admin', 'project_manager'), async (req, res) => {
  const body = CompanyMemberSchema.parse(req.body);
  const role = body.role ?? 'developer';

  const company = await prisma.company.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!company) throw new AppError(404, 'Company not found', 'NOT_FOUND');

  const userOk = await prisma.user.findFirst({ where: { id: body.userId, deletedAt: null } });
  if (!userOk) throw new AppError(404, 'User not found', 'NOT_FOUND');

  await prisma.companyMember.upsert({
    where: { companyId_userId: { companyId: company.id, userId: body.userId } },
    create: { companyId: company.id, userId: body.userId, role },
    update: { role },
  });

  const members = await prisma.companyMember.findMany({
    where: { companyId: company.id },
    include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
  });
  res.json({ success: true, data: members });
});

router.delete('/:companyId/members/:userId', requireRole('admin'), async (req, res) => {
  await prisma.companyMember.deleteMany({
    where: { companyId: req.params.companyId, userId: req.params.userId },
  });
  res.json({ success: true, message: 'Member removed' });
});

export default router;
