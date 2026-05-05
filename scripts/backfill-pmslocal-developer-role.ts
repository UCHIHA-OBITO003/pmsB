import { prisma } from '../src/utils/prisma';

/** One-time: attach `developer` to active users that have no roles and use generated `@pms.local` logins. */
async function main() {
  const role = await prisma.role.findFirst({ where: { name: 'developer' } });
  if (!role) throw new Error('Role "developer" not found — run prisma seed first.');

  const users = await prisma.user.findMany({
    where: {
      deletedAt: null,
      status: 'ACTIVE',
      roles: { none: {} },
      email: { endsWith: '@pms.local' },
    },
    select: { id: true },
  });

  if (users.length === 0) {
    console.log('No matching users (active, @pms.local, zero roles). Nothing to do.');
    return;
  }

  const result = await prisma.userRole.createMany({
    data: users.map((u) => ({ userId: u.id, roleId: role.id })),
    skipDuplicates: true,
  });

  console.log(`Inserted ${result.count} user_role rows for ${users.length} users (skipDuplicates=true).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
