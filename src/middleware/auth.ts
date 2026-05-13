import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../utils/config';
import { prisma } from '../utils/prisma';
import { redis } from '../utils/redis';
import { AppError } from './errorHandler';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    roles: string[];
    permissions: string[];
  };
}

type AuthSnapshot = {
  id: string;
  email: string;
  status: string;
  roles: string[];
  permissions: string[];
};

const AUTH_CACHE_TTL_SECONDS = 180;
const AUTH_CACHE_PREFIX = 'auth:snapshot:';

function authCacheKey(userId: string): string {
  return `${AUTH_CACHE_PREFIX}${userId}`;
}

async function readAuthSnapshot(userId: string): Promise<AuthSnapshot | null> {
  try {
    const raw = await redis.get(authCacheKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthSnapshot;
    if (!parsed?.id || !Array.isArray(parsed.roles) || !Array.isArray(parsed.permissions)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeAuthSnapshot(snapshot: AuthSnapshot): Promise<void> {
  try {
    await redis.set(authCacheKey(snapshot.id), JSON.stringify(snapshot), 'EX', AUTH_CACHE_TTL_SECONDS);
  } catch {
    // Cache failures should not block auth.
  }
}

async function loadAuthSnapshot(userId: string): Promise<AuthSnapshot | null> {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: {
      id: true,
      email: true,
      status: true,
      roles: {
        select: {
          role: {
            select: {
              name: true,
              permissions: {
                select: {
                  permission: {
                    select: {
                      resource: true,
                      action: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!user) return null;

  const roles = user.roles.map((ur) => ur.role.name);
  const permissions = [...new Set(user.roles.flatMap((ur) =>
    ur.role.permissions.map((rp) => `${rp.permission.resource}:${rp.permission.action}`),
  ))];

  return {
    id: user.id,
    email: user.email,
    status: user.status,
    roles,
    permissions,
  };
}

export async function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw new AppError(401, 'No token provided', 'UNAUTHORIZED');
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, config.jwt.secret) as {
      sub: string;
      email: string;
    };

    const cached = await readAuthSnapshot(decoded.sub);
    const snapshot = cached ?? (await loadAuthSnapshot(decoded.sub));

    if (!snapshot || snapshot.status !== 'ACTIVE') {
      throw new AppError(401, 'User not found or inactive', 'UNAUTHORIZED');
    }

    if (!cached) {
      void writeAuthSnapshot(snapshot);
    }

    req.user = {
      id: snapshot.id,
      email: snapshot.email,
      roles: snapshot.roles,
      permissions: snapshot.permissions,
    };
    next();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(401, 'Invalid or expired token', 'UNAUTHORIZED');
  }
}

export function requirePermission(resource: string, action: string) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');

    const hasPermission = req.user.permissions.includes(`${resource}:${action}`) ||
      req.user.roles.includes('admin');

    if (!hasPermission) {
      throw new AppError(
        403,
        `Insufficient permissions (need "${resource}:${action}" on your roles). Ask an admin to assign a role or add this permission.`,
        'FORBIDDEN',
      );
    }
    next();
  };
}

export function requireRole(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
    const hasRole = roles.some((r) => req.user!.roles.includes(r)) || req.user.roles.includes('admin');
    if (!hasRole) throw new AppError(403, 'Role not allowed', 'FORBIDDEN');
    next();
  };
}
