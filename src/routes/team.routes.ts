import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { authenticate, requireRole } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';

const router = Router();
router.use(authenticate);

const CreateTeamSchema = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(4000).optional(),
  leadId: z.string().uuid().optional().nullable(),
});

const PatchTeamSchema = CreateTeamSchema.partial();

const MemberBodySchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(['lead', 'member']).optional(),
});

async function membersWithUsers(teamId: string) {
  const members = await prisma.teamMember.findMany({
    where: { teamId },
    orderBy: { joinedAt: 'asc' },
  });
  const userIds = members.map((m) => m.userId);
  if (userIds.length === 0) return [];
  const users = await prisma.user.findMany({
    where: { id: { in: userIds }, deletedAt: null },
    select: { id: true, email: true, firstName: true, lastName: true, avatar: true, status: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));
  return members.map((m) => ({ ...m, user: byId.get(m.userId) ?? null }));
}

async function listTeamsWithLead() {
  const teams = await prisma.team.findMany({
    where: { deletedAt: null },
    orderBy: { name: 'asc' },
    include: { _count: { select: { members: true, projects: true } } },
  });
  const leadIds = [...new Set(teams.map((t) => t.leadId).filter((id): id is string => Boolean(id)))];
  const leads =
    leadIds.length > 0 ?
      await prisma.user.findMany({
        where: { id: { in: leadIds }, deletedAt: null },
        select: { id: true, email: true, firstName: true, lastName: true, avatar: true },
      })
    : [];
  const leadMap = new Map(leads.map((u) => [u.id, u]));
  return teams.map((t) => ({
    ...t,
    lead: t.leadId ? (leadMap.get(t.leadId) ?? null) : null,
  }));
}

// GET /api/teams
router.get('/', requireRole('admin', 'project_manager'), async (_req, res) => {
  const data = await listTeamsWithLead();
  res.json({ success: true, data });
});

// GET /api/teams/:id
router.get('/:id', requireRole('admin', 'project_manager'), async (req, res) => {
  const team = await prisma.team.findFirst({
    where: { id: req.params.id, deletedAt: null },
    include: { _count: { select: { members: true, projects: true } } },
  });
  if (!team) throw new AppError(404, 'Team not found', 'NOT_FOUND');

  const [members, lead] = await Promise.all([
    membersWithUsers(team.id),
    team.leadId ?
      prisma.user.findFirst({
        where: { id: team.leadId, deletedAt: null },
        select: { id: true, email: true, firstName: true, lastName: true, avatar: true },
      })
    : Promise.resolve(null),
  ]);

  res.json({ success: true, data: { ...team, members, lead } });
});

// POST /api/teams
router.post('/', requireRole('admin'), async (req, res) => {
  const body = CreateTeamSchema.parse(req.body);

  if (body.leadId) {
    const u = await prisma.user.findFirst({ where: { id: body.leadId, deletedAt: null } });
    if (!u) throw new AppError(404, 'Lead user not found', 'NOT_FOUND');
  }

  const team = await prisma.team.create({
    data: {
      name: body.name,
      description: body.description,
      leadId: body.leadId ?? undefined,
      ...(body.leadId ?
        {
          members: {
            create: [{ userId: body.leadId, role: 'lead' }],
          },
        }
      : {}),
    },
  });

  const full = await listTeamsWithLead();
  const row = full.find((t) => t.id === team.id);
  res.status(201).json({ success: true, data: row ?? team });
});

// PATCH /api/teams/:id
router.patch('/:id', requireRole('admin', 'project_manager'), async (req, res) => {
  const patch = PatchTeamSchema.parse(req.body);

  const team = await prisma.team.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!team) throw new AppError(404, 'Team not found', 'NOT_FOUND');

  if (patch.leadId !== undefined && patch.leadId !== null) {
    const u = await prisma.user.findFirst({ where: { id: patch.leadId, deletedAt: null } });
    if (!u) throw new AppError(404, 'Lead user not found', 'NOT_FOUND');
  }

  const data: { name?: string; description?: string | null; leadId?: string | null } = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.description !== undefined) data.description = patch.description === '' ? null : patch.description;
  if (patch.leadId !== undefined) data.leadId = patch.leadId;

  await prisma.team.update({ where: { id: team.id }, data });

  if (patch.leadId !== undefined && patch.leadId !== null) {
    await prisma.teamMember.upsert({
      where: { teamId_userId: { teamId: team.id, userId: patch.leadId } },
      create: { teamId: team.id, userId: patch.leadId, role: 'lead' },
      update: { role: 'lead' },
    });
  }

  const updated = await prisma.team.findFirst({
    where: { id: team.id },
    include: { _count: { select: { members: true, projects: true } } },
  });
  const members = await membersWithUsers(team.id);
  const lead =
    updated?.leadId ?
      await prisma.user.findFirst({
        where: { id: updated.leadId, deletedAt: null },
        select: { id: true, email: true, firstName: true, lastName: true, avatar: true },
      })
    : null;

  res.json({ success: true, data: { ...updated!, members, lead } });
});

// DELETE /api/teams/:id (soft delete; unlink projects)
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const team = await prisma.team.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!team) throw new AppError(404, 'Team not found', 'NOT_FOUND');

  await prisma.$transaction([
    prisma.project.updateMany({ where: { teamId: team.id }, data: { teamId: null } }),
    prisma.team.update({ where: { id: team.id }, data: { deletedAt: new Date() } }),
  ]);

  res.json({ success: true, message: 'Team archived' });
});

// POST /api/teams/:id/members
router.post('/:id/members', requireRole('admin', 'project_manager'), async (req, res) => {
  const body = MemberBodySchema.parse(req.body);
  const role = body.role ?? 'member';

  const team = await prisma.team.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!team) throw new AppError(404, 'Team not found', 'NOT_FOUND');

  const userOk = await prisma.user.findFirst({ where: { id: body.userId, deletedAt: null } });
  if (!userOk) throw new AppError(404, 'User not found', 'NOT_FOUND');

  await prisma.teamMember.upsert({
    where: { teamId_userId: { teamId: team.id, userId: body.userId } },
    create: { teamId: team.id, userId: body.userId, role },
    update: { role },
  });

  if (role === 'lead') {
    await prisma.team.update({ where: { id: team.id }, data: { leadId: body.userId } });
  }

  const members = await membersWithUsers(team.id);
  res.json({ success: true, data: members });
});

// DELETE /api/teams/:id/members/:userId
router.delete('/:id/members/:userId', requireRole('admin', 'project_manager'), async (req, res) => {
  const { id: teamId, userId } = req.params;

  const team = await prisma.team.findFirst({ where: { id: teamId, deletedAt: null } });
  if (!team) throw new AppError(404, 'Team not found', 'NOT_FOUND');

  await prisma.teamMember.deleteMany({ where: { teamId, userId } });

  if (team.leadId === userId) {
    await prisma.team.update({ where: { id: teamId }, data: { leadId: null } });
  }

  const members = await membersWithUsers(teamId);
  res.json({ success: true, data: members });
});

export default router;
