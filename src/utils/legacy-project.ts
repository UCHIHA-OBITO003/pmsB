import { prisma } from './prisma';
import { config } from './config';

/**
 * Resolves the UUID of the project where Codemagen-backed sheet rows should land.
 */
export async function resolveLegacyTicketProjectId(
  legacyTicketProjectId?: string | null,
): Promise<{ id: string; key: string } | null> {
  if (legacyTicketProjectId) {
    const p = await prisma.project.findFirst({
      where: { id: legacyTicketProjectId, deletedAt: null },
      select: { id: true, key: true },
    });
    if (p) return p;
  }
  const key = config.legacyTicketProjectKey || 'EEP';
  const p = await prisma.project.findFirst({
    where: { key, deletedAt: null },
    select: { id: true, key: true },
  });
  return p;
}
