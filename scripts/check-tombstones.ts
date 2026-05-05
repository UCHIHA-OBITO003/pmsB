import { prisma } from '../src/utils/prisma';

async function main() {
  // Check what source IDs were recorded in merge audit logs
  const mergeLogs = await prisma.auditLog.findMany({
    where: { action: 'user_merge' },
    select: { id: true, createdAt: true, metadata: true, resourceId: true },
    orderBy: { createdAt: 'desc' },
  });

  console.log(`Found ${mergeLogs.length} merge audit log entries\n`);

  for (const log of mergeLogs) {
    const meta = log.metadata as any;
    const sourceIds: string[] = meta?.sourceIds ?? meta?.sourcesDeactivated ?? [];
    console.log(`Merge ${log.id.slice(0, 8)} at ${log.createdAt.toISOString()}`);
    console.log(`  target: ${log.resourceId}`);
    console.log(`  sources: ${sourceIds.join(', ')}`);

    for (const sid of sourceIds) {
      const u = await prisma.user.findFirst({
        where: { id: sid },
        select: { id: true, email: true, status: true, deletedAt: true },
      });
      if (!u) {
        console.log(`  [${sid.slice(0, 8)}] NOT FOUND`);
      } else {
        const ok = u.deletedAt !== null;
        console.log(`  [${sid.slice(0, 8)}] email=${u.email} status=${u.status} tombstoned=${ok}`);
      }
    }
    console.log('');
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
