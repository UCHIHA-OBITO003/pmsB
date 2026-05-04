import type { Prisma } from '@prisma/client';

/** Admins / PMs see every ticket (subject to filters). Others only see participant tickets. */
export function seesAllTickets(roles: string[]): boolean {
  return roles.some((r) => r === 'admin' || r === 'project_manager');
}

/**
 * Narrow ticket queries so non-elevated roles only load tickets they are assigned to or reported themselves.
 * Mutates the Prisma `where` input (AND-composes with existing clauses).
 */
export function applyTicketParticipantScope(
  where: Prisma.TicketWhereInput,
  userId: string,
  roles: string[],
): void {
  if (seesAllTickets(roles)) return;
  const participant: Prisma.TicketWhereInput = {
    OR: [{ assignees: { some: { id: userId } } }, { reporterId: userId }],
  };
  const prev = where.AND;
  if (prev === undefined) {
    where.AND = [participant];
  } else if (Array.isArray(prev)) {
    where.AND = [...prev, participant];
  } else {
    where.AND = [prev, participant];
  }
}
