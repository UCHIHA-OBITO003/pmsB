import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { authenticate, requirePermission, requireRole, AuthRequest } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import bcrypt from 'bcryptjs';
import { sendWelcomeCredentialsEmail, sendAdminProfileNotificationEmail } from '../services/user-mail.service';
import { mergeUsersIntoTarget } from '../services/user-merge.service';
import { smtpCredentialsPresent } from '../services/email.service';
import type { QueueEmailResult } from '../services/email-dispatch.service';
import { logger } from '../utils/logger';
import { applyCodemagenUserVisibility, getCodemagenEnabled } from '../utils/system-settings';
import { enqueueGitHubIdentityRemap } from '../queues';
import { deleteUserGitHubIdentity, listUserGitHubSuggestions, upsertUserGitHubIdentity } from '../services/github.service';
import { resolveOwnerAnalyticsWindow, sendOwnerAnalyticsReport } from '../services/owner-analytics-report.service';

type UserRowPlain = NonNullable<Awaited<ReturnType<typeof prisma.user.findFirst>>>;

function patchNotifyLines(args: {
  user: { email: string };
  before: UserRowPlain;
  profileFields: Record<string, unknown>;
  nextEmailRaw: string | undefined;
  newPassword: string | undefined;
}): string[] {
  const { user, before, profileFields, nextEmailRaw, newPassword } = args;
  const lines: string[] = [];
  if (nextEmailRaw && before.email !== user.email) {
    lines.push(`Login email: ${before.email} → ${user.email}`);
  }
  if (profileFields.firstName && profileFields.firstName !== before.firstName) {
    lines.push(`First name: ${before.firstName} → ${profileFields.firstName}`);
  }
  if (profileFields.lastName && profileFields.lastName !== before.lastName) {
    lines.push(`Last name: ${before.lastName} → ${profileFields.lastName}`);
  }
  if (profileFields.department !== undefined && profileFields.department !== before.department) {
    lines.push(`Department updated`);
  }
  if (profileFields.designation !== undefined && profileFields.designation !== before.designation) {
    lines.push(`Designation updated`);
  }
  if (profileFields.status && profileFields.status !== before.status) {
    lines.push(`Account status: ${before.status} → ${profileFields.status}`);
  }
  if (newPassword) {
    lines.push('Password was reset by an administrator');
  } else if (lines.length === 0) {
    lines.push('Your account was updated by an administrator');
  }
  return lines;
}

async function notifyAdminUserPatchEmail(args: {
  user: { id: string; email: string; firstName: string };
  before: UserRowPlain;
  profileFields: Record<string, unknown>;
  nextEmailRaw: string | undefined;
  newPassword: string | undefined;
}): Promise<QueueEmailResult> {
  const { user, before, profileFields, nextEmailRaw, newPassword } = args;

  const lines = patchNotifyLines({ user, before, profileFields, nextEmailRaw, newPassword });

  const notifyResult = await sendAdminProfileNotificationEmail({
    userId: user.id,
    to: user.email,
    firstName: user.firstName,
    lines,
    plainPasswordSent: Boolean(newPassword),
    newPasswordPlain: newPassword,
  });

  if (!notifyResult.queued) {
    logger.warn({ userId: user.id, email: user.email, reason: notifyResult.reason }, 'Admin profile notification email not queued');
  }
  return notifyResult;
}

const router = Router();
router.use(authenticate);

const UpdateUserSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().optional(),
  department: z.string().optional(),
  designation: z.string().optional(),
  skills: z.array(z.string()).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']).optional(),
});

const AdminUserPatchSchema = z.object({
  email: z.string().email().optional(),
  newPassword: z.string().min(8).optional(),
  notifyUserViaEmail: z.boolean().optional(),
  /** Replaces all role assignments when present; admin only */
  roleIds: z.array(z.string().min(1)).optional(),
});

const PatchUserBodySchema = UpdateUserSchema.merge(AdminUserPatchSchema);
const GitHubIdentityBodySchema = z.object({
  githubUserId: z.string().min(1),
  login: z.string().min(1),
  displayName: z.string().optional().nullable(),
  primaryEmail: z.union([z.string().email(), z.literal('')]).optional().nullable(),
  avatarUrl: z.union([z.string().url(), z.literal('')]).optional().nullable(),
  profileUrl: z.union([z.string().url(), z.literal('')]).optional().nullable(),
  source: z.enum(['MANUAL', 'AUTO', 'EMAIL', 'WEBHOOK']).optional(),
  remapProjectId: z.string().uuid().optional(),
  remapLookbackDays: z.number().int().min(1).max(365).optional(),
  remapNow: z.boolean().optional(),
});

const OwnerReportSettingsSchema = z.object({
  ownerAnalyticsEnabled: z.boolean(),
  ownerAnalyticsCadence: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM']),
  ownerAnalyticsLookbackDays: z.number().int().min(1).max(365).optional().nullable(),
});

const OwnerReportSendSchema = z.object({
  window: z.enum(['daily', 'weekly', 'monthly', 'custom']).optional(),
  lookbackDays: z.number().int().min(1).max(365).optional(),
});

const CreateUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).optional(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().optional(),
  department: z.string().optional(),
  designation: z.string().optional(),
  skills: z.array(z.string()).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']).optional(),
  roleIds: z.array(z.string().min(1)).optional(),
  sendWelcomeEmail: z.boolean().optional(),
});

const UpdateMeSchema = UpdateUserSchema.omit({ status: true });

// PATCH /api/users/me — self-service profile (any authenticated user)
router.patch('/me', async (req: AuthRequest, res) => {
  const data = UpdateMeSchema.parse(req.body);
  const user = await prisma.user.update({
    where: { id: req.user!.id },
    data,
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      department: true,
      designation: true,
      phone: true,
      skills: true,
    },
  });
  res.json({ success: true, data: user });
});

// PATCH /api/users/me/password
router.patch('/me/password', async (req: AuthRequest, res) => {
  const { currentPassword, newPassword } = z
    .object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(8),
    })
    .parse(req.body);

  const account = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!account) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');

  const valid = await bcrypt.compare(currentPassword, account.password);
  if (!valid) throw new AppError(401, 'Current password is incorrect', 'INVALID_CREDENTIALS');

  const hashed = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({ where: { id: account.id }, data: { password: hashed } });

  res.json({ success: true, message: 'Password updated' });
});

// GET /api/users/me
router.get('/me', async (req: AuthRequest, res) => {
  const user = await prisma.user.findFirst({
    where: { id: req.user!.id, deletedAt: null },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      avatar: true,
      phone: true,
      department: true,
      designation: true,
      skills: true,
      status: true,
      lastLogin: true,
      createdAt: true,
      roles: { select: { role: { select: { id: true, name: true } } } },
      githubIdentity: true,
    },
  });
  if (!user) throw new AppError(404, 'User not found', 'NOT_FOUND');
  res.json({ success: true, data: user });
});

// GET /api/users
router.get('/', requirePermission('users', 'read'), async (req, res) => {
  const {
    search,
    department,
    status,
    page = '1',
    limit = '20',
    companyId,
    organisationId,
    projectId,
    hideInactive,
    showArchived,
  } = req.query as Record<string, string>;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  // showArchived=true → only tombstoned users; default → only active rows
  const where: any = showArchived === 'true' ? { NOT: { deletedAt: null } } : { deletedAt: null };
  applyCodemagenUserVisibility(where, await getCodemagenEnabled());
  if (search) {
    where.OR = [
      { firstName: { contains: search, mode: 'insensitive' } },
      { lastName: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
    ];
  }
  if (department) where.department = department;
  if (hideInactive === 'true') {
    where.status = 'ACTIVE';
  } else if (status) {
    where.status = status;
  }

  if (companyId) {
    where.companyMembers = { some: { companyId } };
  }
  if (organisationId) {
    where.organisationMembers = { some: { organisationId } };
  }
  if (projectId) {
    where.projectMemberships = { some: { projectId } };
  }

  const [users, total] = await prisma.$transaction([
    prisma.user.findMany({
      where,
      select: {
        id: true, email: true, firstName: true, lastName: true,
        avatar: true, department: true, designation: true,
        skills: true, status: true, lastLogin: true, createdAt: true,
        roles: { select: { role: { select: { id: true, name: true } } } },
        scorecard: { select: { totalScore: true, band: true } },
        githubIdentity: true,
        emailPreferences: {
          select: {
            ownerAnalyticsEnabled: true,
            ownerAnalyticsCadence: true,
            ownerAnalyticsLookbackDays: true,
            lastOwnerAnalyticsSentAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit),
    }),
    prisma.user.count({ where }),
  ]);

  res.json({ success: true, data: { users, total, page: parseInt(page), limit: parseInt(limit) } });
});

// POST /api/users — admin creates user (optional welcome email with password)
router.post('/', requireRole('admin'), async (req: AuthRequest, res) => {
  const data = CreateUserSchema.parse(req.body);
  const email = data.email.trim().toLowerCase();
  const dup = await prisma.user.findFirst({ where: { email } });
  if (dup) throw new AppError(409, 'Email already in use', 'DUPLICATE_EMAIL');

  const plainPassword =
    data.password ??
    `${crypto.randomBytes(14).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').padEnd(10, 'x')}Aa1`;
  const hashed = await bcrypt.hash(plainPassword, 12);

  let roleIds = data.roleIds;
  if (!roleIds?.length) {
    const dev = await prisma.role.findFirst({ where: { name: 'developer' } });
    roleIds = dev ? [dev.id] : [];
  }

  const user = await prisma.user.create({
    data: {
      email,
      password: hashed,
      firstName: data.firstName,
      lastName: data.lastName,
      phone: data.phone,
      department: data.department,
      designation: data.designation,
      skills: data.skills ?? [],
      status: data.status ?? 'ACTIVE',
      roles:
        roleIds.length > 0
          ? { create: roleIds.map((roleId) => ({ roleId })) }
          : undefined,
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      status: true,
      roles: { select: { role: { select: { id: true, name: true } } } },
    },
  });

  if (data.sendWelcomeEmail) {
    const r = await sendWelcomeCredentialsEmail({
      userId: user.id,
      to: user.email,
      firstName: user.firstName,
      email: user.email,
      temporaryPassword: plainPassword,
    });
    if (!r.queued) {
      logger.warn({ userId: user.id, email: user.email, reason: r.reason }, 'Welcome email not queued');
    }
  }

  res.status(201).json({
    success: true,
    data: {
      user,
      temporaryPassword: data.sendWelcomeEmail ? undefined : plainPassword,
      welcomeEmailQueued: data.sendWelcomeEmail,
      smtpConfigured: smtpCredentialsPresent(),
    },
  });
});

// POST /api/users/merge — admin merges duplicate accounts into one
router.post('/merge', requireRole('admin'), async (req: AuthRequest, res) => {
  const { targetUserId, sourceUserIds } = z
    .object({
      targetUserId: z.string().min(1),
      sourceUserIds: z.array(z.string().min(1)).min(1),
    })
    .parse(req.body);

  const result = await mergeUsersIntoTarget(targetUserId, sourceUserIds, req.user?.id);
  res.json({ success: true, data: result });
});

router.patch('/:id/github-identity', requireRole('admin'), async (req: AuthRequest, res) => {
  const body = GitHubIdentityBodySchema.parse(req.body ?? {});
  const exists = await prisma.user.findFirst({ where: { id: req.params.id, deletedAt: null }, select: { id: true } });
  if (!exists) throw new AppError(404, 'User not found', 'NOT_FOUND');

  const data = await upsertUserGitHubIdentity({
    userId: req.params.id,
    githubUserId: body.githubUserId,
    login: body.login,
    displayName: body.displayName ?? null,
    primaryEmail: body.primaryEmail || null,
    avatarUrl: body.avatarUrl || null,
    profileUrl: body.profileUrl || null,
    source: body.source ?? 'MANUAL',
  });

  let remapQueued = false;
  if (body.remapNow && body.remapProjectId) {
    await enqueueGitHubIdentityRemap({
      type: 'remap-project-identity',
      projectId: body.remapProjectId,
      userId: req.params.id,
      requestedBy: req.user?.id,
      lookbackDays: body.remapLookbackDays,
    });
    remapQueued = true;
  }

  res.json({ success: true, data: { ...data, remapQueued } });
});

router.delete('/:id/github-identity', requireRole('admin'), async (req, res) => {
  await deleteUserGitHubIdentity(req.params.id);
  res.json({ success: true, message: 'GitHub identity removed' });
});

// POST /api/users/admin/merge — alias (plan-aligned path)
router.post('/admin/merge', requireRole('admin'), async (req: AuthRequest, res) => {
  const { survivorId, mergeIds } = z
    .object({
      survivorId: z.string().min(1),
      mergeIds: z.array(z.string().min(1)).min(1),
    })
    .parse(req.body);

  const result = await mergeUsersIntoTarget(survivorId, mergeIds, req.user?.id);
  res.json({ success: true, data: result });
});

router.get('/:id/github-suggestions', requireRole('admin'), async (req, res) => {
  const query = z
    .object({
      projectId: z.string().uuid().optional(),
      days: z.coerce.number().int().min(1).max(365).optional(),
    })
    .parse(req.query ?? {});

  const data = await listUserGitHubSuggestions(req.params.id, {
    projectId: query.projectId,
    days: query.days,
  });
  res.json({ success: true, data });
});

router.patch('/:id/owner-report-settings', requireRole('admin'), async (req, res) => {
  const body = OwnerReportSettingsSchema.parse(req.body ?? {});
  const user = await prisma.user.findFirst({
    where: { id: req.params.id, deletedAt: null },
    select: { id: true },
  });
  if (!user) throw new AppError(404, 'User not found', 'NOT_FOUND');

  const data = await prisma.userEmailPreference.upsert({
    where: { userId: req.params.id },
    create: {
      userId: req.params.id,
      ownerAnalyticsEnabled: body.ownerAnalyticsEnabled,
      ownerAnalyticsCadence: body.ownerAnalyticsCadence,
      ownerAnalyticsLookbackDays: body.ownerAnalyticsCadence === 'CUSTOM' ? body.ownerAnalyticsLookbackDays ?? 14 : null,
    },
    update: {
      ownerAnalyticsEnabled: body.ownerAnalyticsEnabled,
      ownerAnalyticsCadence: body.ownerAnalyticsCadence,
      ownerAnalyticsLookbackDays: body.ownerAnalyticsCadence === 'CUSTOM' ? body.ownerAnalyticsLookbackDays ?? 14 : null,
    },
    select: {
      ownerAnalyticsEnabled: true,
      ownerAnalyticsCadence: true,
      ownerAnalyticsLookbackDays: true,
      lastOwnerAnalyticsSentAt: true,
    },
  });

  res.json({ success: true, data });
});

router.post('/:id/owner-analytics-report', requireRole('admin'), async (req, res) => {
  const body = OwnerReportSendSchema.parse(req.body ?? {});
  const cadence = body.window ?? 'daily';
  const window = resolveOwnerAnalyticsWindow({
    cadence,
    lookbackDays: cadence === 'custom' ? body.lookbackDays ?? 14 : undefined,
  });
  const { report, queue } = await sendOwnerAnalyticsReport(req.params.id, { window, source: 'manual' });

  res.json({
    success: true,
    data: {
      queued: queue.queued,
      reason: queue.queued ? undefined : queue.reason,
      smtpConfigured: queue.smtpConfigured,
      windowLabel: report.window.label,
      totals: report.totals,
    },
  });
});

// GET /api/users/:id
router.get('/:id', requirePermission('users', 'read'), async (req, res) => {
  const user = await prisma.user.findFirst({
    where: { id: req.params.id, deletedAt: null },
    select: {
      id: true, email: true, firstName: true, lastName: true,
      avatar: true, phone: true, department: true, designation: true,
      skills: true, status: true, lastLogin: true, createdAt: true,
      roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
      scorecard: true,
      availability: { orderBy: { date: 'desc' }, take: 30 },
      githubIdentity: true,
      emailPreferences: true,
    },
  });

  if (!user) throw new AppError(404, 'User not found', 'NOT_FOUND');
  res.json({ success: true, data: user });
});

// PATCH /api/users/:id
router.patch('/:id', requirePermission('users', 'update'), async (req: AuthRequest, res) => {
  const data = PatchUserBodySchema.parse(req.body);
  const targetId = req.params.id;
  const isAdmin = req.user?.roles.includes('admin') ?? false;
  const editingOther = targetId !== req.user!.id;

  if (data.status && !isAdmin) {
    throw new AppError(403, 'Only admins can change user status', 'FORBIDDEN');
  }

  if (data.roleIds !== undefined && !isAdmin) {
    throw new AppError(403, 'Only admins can assign roles', 'FORBIDDEN');
  }

  const adminOnlyFields =
    data.email !== undefined ||
    data.newPassword !== undefined ||
    data.notifyUserViaEmail === true ||
    data.roleIds !== undefined;
  if (editingOther && adminOnlyFields && !isAdmin) {
    throw new AppError(
      403,
      'Only admins can change email, password, roles, or send notifications for other users',
      'FORBIDDEN',
    );
  }

  if (!isAdmin && (data.email !== undefined || data.newPassword !== undefined)) {
    throw new AppError(403, 'Use profile settings to change your own email or password', 'FORBIDDEN');
  }

  const before = await prisma.user.findFirst({
    where: { id: targetId, deletedAt: null },
  });
  if (!before) throw new AppError(404, 'User not found', 'NOT_FOUND');

  const {
    email: nextEmailRaw,
    newPassword,
    notifyUserViaEmail,
    roleIds,
    ...profileFields
  } = data;

  const prismaData: Record<string, unknown> = { ...profileFields };
  if (nextEmailRaw !== undefined) {
    prismaData.email = nextEmailRaw.trim().toLowerCase();
  }
  if (newPassword) {
    prismaData.password = await bcrypt.hash(newPassword, 12);
  }

  const user = await prisma.$transaction(async (tx) => {
    if (newPassword) {
      await tx.refreshToken.updateMany({
        where: { userId: targetId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    const u = await tx.user.update({
      where: { id: targetId },
      data: prismaData,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        department: true,
        designation: true,
        skills: true,
        status: true,
        phone: true,
      },
    });

    if (roleIds !== undefined && isAdmin) {
      const uniqueRoleIds = [...new Set(roleIds)];
      if (uniqueRoleIds.length === 0) {
        throw new AppError(400, 'Select at least one role', 'BAD_REQUEST');
      }
      const found = await tx.role.count({ where: { id: { in: uniqueRoleIds } } });
      if (found !== uniqueRoleIds.length) {
        throw new AppError(400, 'One or more roles were not found', 'BAD_REQUEST');
      }
      await tx.userRole.deleteMany({ where: { userId: targetId } });
      await tx.userRole.createMany({
        data: uniqueRoleIds.map((rid) => ({ userId: targetId, roleId: rid })),
      });
    }

    return u;
  });

  let notifyMeta:
    | {
        notifyEmailQueued: true;
        smtpConfigured: boolean;
      }
    | undefined;

  if (notifyUserViaEmail && isAdmin) {
    const notifyResult = await notifyAdminUserPatchEmail({
      user,
      before,
      profileFields,
      nextEmailRaw,
      newPassword,
    });

    notifyMeta = {
      notifyEmailQueued: true,
      smtpConfigured: smtpCredentialsPresent(),
    };
  }

  res.json({
    success: true,
    data: user,
    ...(notifyMeta ? { meta: notifyMeta } : {}),
  });
});

// DELETE /api/users/:id (soft delete / tombstone)
router.delete('/:id', requireRole('admin'), async (req: AuthRequest, res) => {
  const u = await prisma.user.findFirst({ where: { id: req.params.id } });
  if (!u) throw new AppError(404, 'User not found', 'NOT_FOUND');
  if (u.id === req.user?.id) throw new AppError(400, 'Cannot deactivate yourself', 'BAD_REQUEST');

  const tombEmail = u.email.includes('@pms.merge')
    ? u.email
    : `archived.${u.id.slice(0, 8)}.${Date.now()}@pms.merge`;

  await prisma.user.update({
    where: { id: u.id },
    data: { deletedAt: new Date(), status: 'INACTIVE', email: tombEmail },
  });
  res.json({ success: true, message: 'User archived' });
});

// POST /api/users/repair-merge-tombstones — finds sources from merge audit logs that aren't tombstoned
router.post('/repair-merge-tombstones', requireRole('admin'), async (_req, res) => {
  const mergeLogs = await prisma.auditLog.findMany({
    where: { action: 'user_merge' },
    select: { metadata: true },
  });

  const allSourceIds: string[] = [];
  for (const log of mergeLogs) {
    const meta = log.metadata as { sourceIds?: string[]; sourcesDeactivated?: string[] } | null;
    const ids = meta?.sourceIds ?? meta?.sourcesDeactivated ?? [];
    allSourceIds.push(...ids);
  }
  const uniqueIds = [...new Set(allSourceIds)];

  const notTombstoned = await prisma.user.findMany({
    where: { id: { in: uniqueIds }, deletedAt: null },
    select: { id: true, email: true },
  });

  let repaired = 0;
  for (const u of notTombstoned) {
    const tombEmail = `merged.${u.id.slice(0, 8)}.${Date.now()}@pms.merge`;
    await prisma.user.update({
      where: { id: u.id },
      data: { deletedAt: new Date(), status: 'INACTIVE', email: tombEmail },
    });
    repaired++;
  }

  res.json({ success: true, data: { checked: uniqueIds.length, repaired, sources: notTombstoned.map(u => u.email) } });
});

// POST /api/users/:id/roles — assign role
router.post('/:id/roles', requirePermission('users', 'update'), async (req, res) => {
  const { roleId } = z.object({ roleId: z.string() }).parse(req.body);
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: req.params.id, roleId } },
    create: { userId: req.params.id, roleId },
    update: {},
  });
  res.json({ success: true, message: 'Role assigned' });
});

export default router;
