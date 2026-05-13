import type { Prisma } from '@prisma/client';
import { AppError } from '../middleware/errorHandler';
import { redis } from './redis';
import { logger } from './logger';

const CODEMAGEN_ENABLED_KEY = 'settings:codemagen:enabled';
const DEFAULT_CODEMAGEN_ENABLED = false;
const CACHE_TTL_MS = 5_000;
const CODEMAGEN_COMPANY_NAME = 'Codemagen';
const HANZ_COMPANY_NAME = 'Hanz';

let codemagenEnabledCache = DEFAULT_CODEMAGEN_ENABLED;
let cacheExpiresAt = 0;

function mergeAnd(where: { AND?: Prisma.Enumerable<Prisma.UserWhereInput> | Prisma.UserWhereInput }, extra: Prisma.UserWhereInput) {
  const prevAnd = where.AND;
  where.AND =
    prevAnd === undefined ? [extra] : Array.isArray(prevAnd) ? [...prevAnd, extra] : [prevAnd, extra];
}

function mergeTicketAnd(
  where: { AND?: Prisma.Enumerable<Prisma.TicketWhereInput> | Prisma.TicketWhereInput },
  extra: Prisma.TicketWhereInput,
) {
  const prevAnd = where.AND;
  where.AND =
    prevAnd === undefined ? [extra] : Array.isArray(prevAnd) ? [...prevAnd, extra] : [prevAnd, extra];
}

export async function getCodemagenEnabled(): Promise<boolean> {
  const now = Date.now();
  if (now < cacheExpiresAt) return codemagenEnabledCache;

  try {
    const raw = await redis.get(CODEMAGEN_ENABLED_KEY);
    codemagenEnabledCache = raw == null ? DEFAULT_CODEMAGEN_ENABLED : raw === '1' || raw === 'true';
  } catch (err) {
    logger.warn({ err }, 'Could not read Codemagen feature flag from Redis; using cached/default value');
  }

  cacheExpiresAt = now + CACHE_TTL_MS;
  return codemagenEnabledCache;
}

export async function setCodemagenEnabled(enabled: boolean): Promise<boolean> {
  try {
    await redis.set(CODEMAGEN_ENABLED_KEY, enabled ? '1' : '0');
  } catch (err) {
    logger.error({ err }, 'Could not persist Codemagen feature flag to Redis');
    throw new AppError(503, 'Could not save system setting', 'SYSTEM_SETTING_UNAVAILABLE');
  }

  codemagenEnabledCache = enabled;
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return enabled;
}

export function codemagenTicketPredicate(): Prisma.TicketWhereInput {
  return {
    OR: [
      {
        AND: [
          { legacySourceKey: { not: null } },
          { legacySourceKey: { startsWith: 'codemagen:' } },
        ],
      },
      { source: 'codemagen_scraper' },
      {
        AND: [
          { sourceUrl: { not: null } },
          { sourceUrl: { contains: 'codemagen', mode: 'insensitive' } },
        ],
      },
    ],
  };
}

export function applyCodemagenTicketVisibility(
  where: { AND?: Prisma.Enumerable<Prisma.TicketWhereInput> | Prisma.TicketWhereInput },
  codemagenEnabled: boolean,
) {
  if (codemagenEnabled) return;
  mergeTicketAnd(where, { NOT: codemagenTicketPredicate() });
}

export function applyCodemagenUserVisibility(
  where: { AND?: Prisma.Enumerable<Prisma.UserWhereInput> | Prisma.UserWhereInput },
  codemagenEnabled: boolean,
) {
  if (codemagenEnabled) return;
  mergeAnd(where, { NOT: { department: { equals: 'Codemagen', mode: 'insensitive' } } });
}

export function isVisibleUserDepartment(department: string | null | undefined, codemagenEnabled: boolean): boolean {
  return codemagenEnabled || !department || department.toLowerCase() !== 'codemagen';
}

export function filterVisibleUsers<T extends { department?: string | null }>(rows: T[], codemagenEnabled: boolean): T[] {
  if (codemagenEnabled) return rows;
  return rows.filter((row) => isVisibleUserDepartment(row.department, codemagenEnabled));
}

export function filterVisibleMembershipUsers<T extends { user?: { department?: string | null } | null }>(
  rows: T[],
  codemagenEnabled: boolean,
): T[] {
  if (codemagenEnabled) return rows;
  return rows.filter((row) => isVisibleUserDepartment(row.user?.department, codemagenEnabled));
}

export function getTicketCompanyLabel(ticket: {
  legacySourceKey?: string | null;
  source?: string | null;
  sourceUrl?: string | null;
  company?: { name?: string | null } | null;
  project?: { company?: { name?: string | null } | null } | null;
}): string {
  const directCompanyName = ticket.company?.name?.trim();
  if (directCompanyName) return directCompanyName;

  const projectCompanyName = ticket.project?.company?.name?.trim();
  if (projectCompanyName) return projectCompanyName;

  const isCodemagenTicket =
    ticket.legacySourceKey?.startsWith('codemagen:') ||
    ticket.source === 'codemagen_scraper' ||
    /codemagen/i.test(ticket.sourceUrl ?? '');

  return isCodemagenTicket ? CODEMAGEN_COMPANY_NAME : HANZ_COMPANY_NAME;
}

export async function assertCodemagenEnabled(action = 'use Codemagen data'): Promise<void> {
  if (await getCodemagenEnabled()) return;
  throw new AppError(
    409,
    `Legacy Codemagen data is hidden. Enable it in Admin -> System to ${action}.`,
    'CODEMAGEN_DISABLED',
  );
}
