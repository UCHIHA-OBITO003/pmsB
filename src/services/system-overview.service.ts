import os from 'os';
import { prisma } from '../utils/prisma';
import { redis } from '../utils/redis';
import { config } from '../utils/config';
import { getCodemagenEnabled } from '../utils/system-settings';
import { smtpCredentialsPresent } from './email.service';
import { CRON_MANIFEST } from '../crons/definitions';
import { getApiHitsSnapshot } from '../utils/api-request-metrics';
import { getQueueMetrics } from '../queues/index';
import { githubAppConfigured } from './github-auth.service';

function formatCronEntries() {
  return CRON_MANIFEST.map((row) => ({
    id: row.id,
    schedule: row.schedule,
    humanHint: cronHumanHint(row.schedule),
    description: row.description,
    scheduleRegistered: true,
    workRunsOnlyWhenConfigured:
      row.requiresEnvFlag != null ? process.env[row.requiresEnvFlag] === 'true' : undefined,
    requiresEnvFlag: row.requiresEnvFlag,
  }));
}

/** Very small helper — cron expressions are authoritative in definitions.ts */
function cronHumanHint(schedule: string): string {
  switch (schedule) {
    case '0 2 * * *':
      return 'Daily at 02:00 (server TZ)';
    case '*/30 * * * *':
      return 'Every 30 minutes';
    case '0 * * * *':
      return 'Every hour';
    case '0 8 * * *':
      return 'Daily at 08:00 (server TZ)';
    case '30 8 * * *':
      return 'Daily at 08:30 (server TZ)';
    default:
      return schedule;
  }
}

async function postgresDbFootprint(): Promise<{ bytes: number | string; pretty?: string } | null> {
  try {
    type Row = { bytes: bigint; pretty: string | null };
    const rows = await prisma.$queryRaw<
      Row[]
    >`SELECT pg_database_size(current_database())::bigint AS bytes,
              pg_size_pretty(pg_database_size(current_database())) AS pretty`;
    const r = rows[0];
    if (!r) return null;
    return {
      bytes: Number(r.bytes),
      pretty: r.pretty ?? undefined,
    };
  } catch {
    return null;
  }
}

async function getEmailOverview() {
  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [statusCounts, latest, failures] = await Promise.all([
      prisma.emailDelivery.groupBy({
        by: ['status'],
        _count: { _all: true },
        where: { queuedAt: { gte: since24h } },
      }),
      prisma.emailDelivery.findMany({
        orderBy: { queuedAt: 'desc' },
        take: 8,
        select: {
          to: true,
          templateKey: true,
          eventType: true,
          status: true,
          queuedAt: true,
          sentAt: true,
          errorDetail: true,
        },
      }),
      prisma.emailDelivery.findMany({
        where: { status: { in: ['FAILED', 'SKIPPED'] } },
        orderBy: { queuedAt: 'desc' },
        take: 5,
        select: {
          to: true,
          eventType: true,
          status: true,
          queuedAt: true,
          errorDetail: true,
        },
      }),
    ]);

    return {
      available: true as const,
      countsLast24h: Object.fromEntries(statusCounts.map((row) => [row.status, row._count._all])),
      latest,
      failures,
      note: 'Statuses are backed by email_deliveries and BullMQ worker updates.',
    };
  } catch (error) {
    return {
      available: false as const,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function getGitHubOverview() {
  try {
    const [installations, links, recentFailures] = await Promise.all([
      prisma.gitHubInstallation.count(),
      prisma.projectGitHubLink.findMany({
        orderBy: { updatedAt: 'desc' },
        take: 8,
        select: {
          projectId: true,
          repositoryFullName: true,
          status: true,
          lastSyncStatus: true,
          lastSyncedAt: true,
          lastSyncError: true,
          project: {
            select: {
              githubProjectTitle: true,
            },
          },
        },
      }),
      prisma.projectGitHubLink.findMany({
        where: { lastSyncStatus: 'FAILED' },
        orderBy: { updatedAt: 'desc' },
        take: 5,
        select: {
          repositoryFullName: true,
          lastSyncError: true,
          updatedAt: true,
        },
      }),
    ]);

    return {
      available: true as const,
      configured: githubAppConfigured(),
      installationCount: installations,
      links,
      recentFailures,
    };
  } catch (error) {
    return {
      available: false as const,
      configured: githubAppConfigured(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function buildSystemOverview() {
  const mem = process.memoryUsage();
  const apiHits = getApiHitsSnapshot();
  let redisOk = false;
  let redisDbSize: number | null = null;
  let redisErr: string | undefined;
  let queueMetrics: Awaited<ReturnType<typeof getQueueMetrics>> | null = null;

  try {
    redisOk = (await redis.ping()) === 'PONG';
    if (redisOk) redisDbSize = await redis.dbsize();
  } catch (e) {
    redisErr = e instanceof Error ? e.message : String(e);
  }

  if (redisOk) {
    try {
      queueMetrics = await getQueueMetrics();
    } catch {
      // non-fatal: queue metrics unavailable if Redis key format changed
    }
  }

  const dbFootprint = await postgresDbFootprint();
  const codemagenEnabled = await getCodemagenEnabled();
  const emailOverview = await getEmailOverview();
  const githubOverview = await getGitHubOverview();

  let externalSyncJobsByStatus: Record<string, number> = {};
  try {
    const rows = await prisma.externalSyncJob.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    externalSyncJobsByStatus = Object.fromEntries(rows.map((row) => [row.status, row._count._all]));
  } catch {
    externalSyncJobsByStatus = {};
  }

  return {
    generatedAt: new Date().toISOString(),
    process: {
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      nodeVersion: process.version,
      env: config.nodeEnv,
    },
    hostMemory: {
      totalBytes: os.totalmem(),
      freeBytes: os.freemem(),
      freePercent: Math.round((os.freemem() / os.totalmem()) * 1000) / 10,
    },
    processMemoryBytes: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
    },
    integrations: {
      redis: redisOk ? { connected: true, keyCountApprox: redisDbSize ?? 0 } : { connected: false, error: redisErr },
      postgres: dbFootprint
        ? {
            reachable: true,
            databaseApproxBytes: dbFootprint.bytes,
            databaseApproxPretty: dbFootprint.pretty,
          }
        : { reachable: false as const },
      smtp: {
        credentialsConfigured: smtpCredentialsPresent(),
        emailPipeline:
          'Transactional mail is queued through BullMQ, rendered by shared template builders, and logged in email_deliveries.',
        deliveries: emailOverview,
      },
      github: githubOverview,
    },
    api: {
      requestsSinceBoot: apiHits.count,
      counterStartedAt: apiHits.since,
      note: 'Increments per request under /api/ after rate limiting (OPTIONS skipped). Resets when the Node process restarts.',
    },
    backgroundWork: {
      cronDriver: 'node-cron (in-process on this Node instance)',
      jobs: formatCronEntries(),
      externalSyncJobsByStatus,
      externalSyncExplanation:
        'external_sync_jobs (mass import sync). Pending = PENDING; running = PROCESSING.',
    },
    queues: queueMetrics
      ? {
          driver: 'BullMQ (Redis-backed)',
          workersActive: true,
          metrics: queueMetrics,
          note: 'import-job: sheet + file imports. email-job: SMTP. legacy-sync-job: Codemagen re-scrape queue. github-job: GitHub repo/project sync. Completed/failed counts reset on restart (removeOnComplete/removeOnFail limits apply).',
        }
      : {
          driver: 'BullMQ (Redis-backed)',
          workersActive: true,
          metrics: null,
          note: 'Queue metrics unavailable — Redis may not be connected yet.',
        },
    featureFlags: {
      codemagenEnabled,
      codemagenNote:
        'Redis-backed global toggle. Off = legacy migrated Codemagen tickets and Codemagen users stay hidden, and new Codemagen ingestion/sync endpoints reject requests.',
    },
    infrastructureNote:
      'VRAM-style limits and egress charts remain in Render / host dashboards — here you see process-visible memory plus DB/Redis pings.',
  };
}
