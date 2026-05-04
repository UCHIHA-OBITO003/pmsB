import bcrypt from 'bcryptjs';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../utils/prisma';
import { config } from '../utils/config';
import { AppError } from '../middleware/errorHandler';
import { z } from 'zod';

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  department: z.string().optional(),
  designation: z.string().optional(),
});

function signAccessToken(userId: string, email: string) {
  return jwt.sign(
    { sub: userId, email },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn } as SignOptions,
  );
}

function signRefreshToken() {
  return uuidv4();
}

export async function loginUser(email: string, password: string) {
  const user = await prisma.user.findFirst({
    where: { email: email.toLowerCase(), deletedAt: null },
    include: {
      roles: { include: { role: true } },
    },
  });

  if (!user) throw new AppError(401, 'Invalid credentials', 'INVALID_CREDENTIALS');
  if (user.status !== 'ACTIVE') throw new AppError(403, 'Account suspended', 'ACCOUNT_SUSPENDED');

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) throw new AppError(401, 'Invalid credentials', 'INVALID_CREDENTIALS');

  const accessToken = signAccessToken(user.id, user.email);
  const refreshTokenStr = signRefreshToken();

  // Store refresh token
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  await prisma.refreshToken.create({
    data: { userId: user.id, token: refreshTokenStr, expiresAt },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLogin: new Date() },
  });

  const roles = user.roles.map((ur) => ur.role.name);

  return {
    accessToken,
    refreshToken: refreshTokenStr,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      avatar: user.avatar,
      department: user.department,
      designation: user.designation,
      roles,
    },
  };
}

export async function registerUser(data: z.infer<typeof RegisterSchema>) {
  const existing = await prisma.user.findUnique({ where: { email: data.email.toLowerCase() } });
  if (existing) throw new AppError(409, 'Email already registered', 'DUPLICATE_EMAIL');

  const hashed = await bcrypt.hash(data.password, 12);

  // Get default 'developer' role
  let role = await prisma.role.findFirst({ where: { name: 'developer' } });

  const user = await prisma.user.create({
    data: {
      email: data.email.toLowerCase(),
      password: hashed,
      firstName: data.firstName,
      lastName: data.lastName,
      department: data.department,
      designation: data.designation,
      roles: role ? { create: [{ roleId: role.id }] } : undefined,
    },
  });

  const accessToken = signAccessToken(user.id, user.email);
  const refreshTokenStr = signRefreshToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await prisma.refreshToken.create({
    data: { userId: user.id, token: refreshTokenStr, expiresAt },
  });

  return {
    accessToken,
    refreshToken: refreshTokenStr,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      roles: role ? ['developer'] : [],
    },
  };
}

export async function refreshTokens(refreshToken: string) {
  const stored = await prisma.refreshToken.findUnique({
    where: { token: refreshToken },
    include: { user: true },
  });

  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    throw new AppError(401, 'Invalid or expired refresh token', 'INVALID_REFRESH_TOKEN');
  }

  if (stored.user.deletedAt) {
    throw new AppError(401, 'Invalid or expired refresh token', 'INVALID_REFRESH_TOKEN');
  }

  if (stored.user.status !== 'ACTIVE') {
    throw new AppError(403, 'Account inactive', 'ACCOUNT_SUSPENDED');
  }

  // Rotate refresh token
  await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });

  const newRefresh = signRefreshToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await prisma.refreshToken.create({
    data: { userId: stored.userId, token: newRefresh, expiresAt },
  });

  const accessToken = signAccessToken(stored.userId, stored.user.email);

  return { accessToken, refreshToken: newRefresh };
}

export async function logoutUser(refreshToken: string) {
  await prisma.refreshToken.updateMany({
    where: { token: refreshToken },
    data: { revokedAt: new Date() },
  });
}
