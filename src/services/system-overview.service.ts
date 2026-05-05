import os from 'os';
import { prisma } from '../utils/prisma';
import { redis } from '../utils/redis';
import { config } from '../utils/config';
import { smtpCredentialsPresent } from './email.service';
import { CRON_MANIFEST } from '../crons/definitions';
import { getApiHitsSnapshot } from '../utils/api-request-metrics';
import { getQueueMetrics } from '../queues/index';

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
          'Mail is sent inside API handlers (nodemailer). There is no mail queue depth to show — use SMTP result toasts when saving users or check Render logs.',
      },
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
          note: 'import-job: sheet + file imports. email-job: SMTP. legacy-sync-job: Codemagen re-scrape queue. Completed/failed counts reset on restart (removeOnComplete/removeOnFail limits apply).',
        }
      : {
          driver: 'BullMQ (Redis-backed)',
          workersActive: true,
          metrics: null,
          note: 'Queue metrics unavailable — Redis may not be connected yet.',
        },
    infrastructureNote:
      'VRAM-style limits and egress charts remain in Render / host dashboards — here you see process-visible memory plus DB/Redis pings.',
  };
}
