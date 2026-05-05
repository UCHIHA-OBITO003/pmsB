import bcrypt from 'bcryptjs';
import { prisma } from './prisma';
import { resolveUserAlias, isHanzDeveloper } from './user-mapping';

/** Ensures the user has the system `developer` role (upsert). */
export async function ensureUserHasDeveloperRole(userId: string): Promise<void> {
  const role = await prisma.role.findFirst({ where: { name: 'developer' } });
  if (!role) return;
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId, roleId: role.id } },
    create: { userId, roleId: role.id },
    update: {},
  });
}

/**
 * Finds an existing active user created from sheet/import flows.
 * Matches: split first+last, canonical `@pms.local` email, then whole firstName (min 2 chars).
 */
export async function findUserForAssigneeImportName(normalizedName: string) {
  const trimmed = normalizedName.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const fn = parts[0];
    const ln = parts.slice(1).join(' ');
    const bySplit = await prisma.user.findFirst({
      where: {
        deletedAt: null,
        firstName: { equals: fn, mode: 'insensitive' },
        lastName: { equals: ln, mode: 'insensitive' },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (bySplit) return bySplit;
  }

  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]/g, '') || 'user';
  const canonicalEmail = `${slug}@pms.local`;
  const byEmail = await prisma.user.findFirst({ where: { email: canonicalEmail, deletedAt: null } });
  if (byEmail) return byEmail;

  if (trimmed.length >= 2) {
    return prisma.user.findFirst({
      where: {
        deletedAt: null,
        firstName: { equals: trimmed, mode: 'insensitive' },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  return null;
}

/**
 * Resolve assignee cell string to a User: prefer existing rows (consistent email / split names),
 * otherwise create developer with `@pms.local`-style login.
 */
export async function resolveOrCreateDeveloperFromAssignee(rawName: string) {
  const name = resolveUserAlias(rawName).trim();
  if (!name) return null;

  let user = await findUserForAssigneeImportName(name);

  if (!user) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'user';
    const email = `${slug}@pms.local`;
    const hash = await bcrypt.hash('Dev@123456', 10);
    const department = isHanzDeveloper(name) ? 'Hanz' : 'Codemagen';

    try {
      user = await prisma.user.create({
        data: {
          firstName: name,
          lastName: '',
          email,
          department,
          password: hash,
          roles: { create: { role: { connect: { name: 'developer' } } } },
        },
      });
    } catch {
      user =
        (await prisma.user.findFirst({ where: { email, deletedAt: null } })) ??
        (await findUserForAssigneeImportName(name));

      if (!user) {
        user = await prisma.user.create({
          data: {
            firstName: name,
            lastName: '',
            email: `${slug}.${Date.now()}@pms.local`,
            department,
            password: hash,
            roles: { create: { role: { connect: { name: 'developer' } } } },
          },
        });
      }
    }
  }

  return user;
}
