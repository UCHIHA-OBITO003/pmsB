import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../utils/prisma';
import { AppError } from '../middleware/errorHandler';
import { sendHtmlEmail } from './email.service';
import { config } from '../utils/config';
import { logger } from '../utils/logger';

const PURPOSE = 'password_reset';
const OTP_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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

  const resetUrl = `${config.app.baseUrl}/reset-password?email=${encodeURIComponent(email)}`;
  const subject = `Your ${config.app.baseUrl.replace(/^https?:\/\//, '')} password reset code`;
  const text = `Hello ${user.firstName},\n\nYour one-time code: ${otp}\n\nIt expires in 15 minutes.\n\nReset page: ${resetUrl}\n`;
  const html = `<p>Hello <strong>${escapeHtml(user.firstName)}</strong>,</p>
<p>Your one-time password reset code:</p>
<p style="font-size:24px;font-weight:bold;letter-spacing:4px">${otp}</p>
<p>This code expires in <strong>15 minutes</strong>.</p>
<p><a href="${resetUrl}">Open reset page</a></p>
<p>If you did not request this, ignore this email.</p>`;

  const mail = await sendHtmlEmail(user.email, subject, html, text);
  if (!mail.ok) {
    logger.error(
      { email, reason: mail.reason, detail: mail.detail },
      'Password reset OTP email not delivered — check SMTP / spam / EMAIL_FROM vs SMTP_USER',
    );
  }
  return { ok: true as const };
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
