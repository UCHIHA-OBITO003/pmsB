import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../utils/prisma';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { enqueueTransactionalEmail } from './email-dispatch.service';
import { buildPasswordResetOtpEmail } from './email-templates/auth-email.templates';

const PURPOSE = 'password_reset';
const OTP_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function generateOtp(): string {
  return String(crypto.randomInt(100000, 1000000));
}

export async function requestPasswordResetOtp(emailRaw: string) {
  const email = emailRaw.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.deletedAt) {
    logger.info({ email }, 'Password reset requested for unknown/inactive user — no leak');
    return { ok: true as const };
  }

  await prisma.emailOtp.deleteMany({ where: { email, purpose: PURPOSE } });

  const otp = generateOtp();
  const codeHash = await bcrypt.hash(otp, 10);
  await prisma.emailOtp.create({
    data: {
      email,
      codeHash,
      purpose: PURPOSE,
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
    },
  });

  const template = buildPasswordResetOtpEmail({
    firstName: user.firstName,
    email,
    otp,
  });
  const queue = await enqueueTransactionalEmail({
    userId: user.id,
    to: user.email,
    template,
    eventType: 'PASSWORD_RESET_OTP',
    resourceType: 'user',
    resourceId: user.id,
    fingerprint: `password-reset:${user.id}:${otp}`,
  });
  if (!queue.queued) {
    logger.warn({ email, reason: queue.reason }, 'Password reset OTP email skipped');
  }
  return { ok: true as const, queued: queue.queued, expiresInMinutes: 15, resendCooldownSeconds: 60 };
}

export async function verifyOtpAndResetPassword(emailRaw: string, otp: string, newPassword: string) {
  const email = emailRaw.trim().toLowerCase();
  const row = await prisma.emailOtp.findFirst({
    where: { email, purpose: PURPOSE, usedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  if (!row) throw new AppError(400, 'Invalid or expired code', 'INVALID_OTP');
  if (row.expiresAt < new Date()) throw new AppError(400, 'Code expired', 'OTP_EXPIRED');
  if (row.attempts >= MAX_ATTEMPTS) throw new AppError(429, 'Too many attempts', 'OTP_LOCKED');

  const ok = await bcrypt.compare(otp, row.codeHash);
  if (!ok) {
    await prisma.emailOtp.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
    throw new AppError(400, 'Invalid code', 'INVALID_OTP');
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.deletedAt) throw new AppError(404, 'User not found', 'NOT_FOUND');

  const hashed = await bcrypt.hash(newPassword, 12);
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { password: hashed } }),
    prisma.emailOtp.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
    prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);

  await prisma.emailOtp.deleteMany({ where: { email, purpose: PURPOSE } });
}
