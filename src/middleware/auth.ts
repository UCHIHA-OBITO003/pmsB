import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../utils/config';
import { prisma } from '../utils/prisma';
import { AppError } from './errorHandler';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    roles: string[];
    permissions: string[];
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

    // Fetch roles & permissions
    const user = await prisma.user.findFirst({
      where: { id: decoded.sub, deletedAt: null },
      include: {
        roles: {
          include: {
            role: {
              include: {
                permissions: { include: { permission: true } },
              },
            },
          },
        },
      },
    });

    if (!user || user.status !== 'ACTIVE') {
      throw new AppError(401, 'User not found or inactive', 'UNAUTHORIZED');
    }

    const roles = user.roles.map((ur) => ur.role.name);
    const permissions = user.roles.flatMap((ur) =>
      ur.role.permissions.map((rp) => `${rp.permission.resource}:${rp.permission.action}`)
    );

    req.user = { id: user.id, email: user.email, roles, permissions };
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
