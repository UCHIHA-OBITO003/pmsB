/**
 * BullMQ queue definitions + enqueue helpers with Redis quota / inline fallbacks.
 */
import { Queue } from 'bullmq';
import { redis } from '../utils/redis';
import { logger } from '../utils/logger';
import {
  getQueueMode,
  isRedisQuotaOrUnavailableError,
  isRedisUsable,
  markRedisUnusable,
} from './queue-runtime';
import { runEmailJobInBackground } from './processors/email.processor';
import { runGitHubJobInBackground } from './processors/github.processor';
import type { EmailJobData, GitHubJobData, ImportJobData, LegacySyncJobData } from './job-types';

export type { EmailJobData, GitHubJobData, ImportJobData, LegacySyncJobData } from './job-types';

export const bullConnection = { client: redis } as const;

export const importQueue = new Queue<ImportJobData>('import-job', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 15_000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
  },
});

export const emailQueue = new Queue<EmailJobData>('email-job', {
  connection: redis,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 100 },
  },
});

export const githubQueue = new Queue<GitHubJobData>('github-job', {
  connection: redis,
  defaultJobOptions: {
    attempts: 4,
    backoff: { type: 'exponential', delay: 20_000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
  },
});

export const legacySyncQueue = new Queue<LegacySyncJobData>('legacy-sync-job', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 20_000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
  },
});

async function addToRedisOrInline<T>(
  label: string,
  inline: () => void,
  redisAdd: () => Promise<T>,
): Promise<T | { id: string; inline: true }> {
  if (getQueueMode() === 'inline' || !isRedisUsable()) {
    inline();
    return { id: `inline-${label}`, inline: true };
  }
  try {
    return await redisAdd();
  } catch (err) {
    if (isRedisQuotaOrUnavailableError(err)) {
      markRedisUnusable(err, label);
      inline();
      return { id: `inline-fallback-${label}`, inline: true };
    }
    throw err;
  }
}

export async function enqueueSheetSync(data: Extract<ImportJobData, { type: 'google-sheet' }>) {
  return addToRedisOrInline('sheet-sync', () => {
    void import('./workers/import.worker')
      .then(({ runImportJobInline }) => runImportJobInline(data))
      .catch((err) => logger.error({ err }, 'inline sheet-sync failed'));
  }, () => importQueue.add('sheet-sync', data, { priority: 10 }));
}

export async function enqueueFileImport(data: Extract<ImportJobData, { type: 'excel-file' }>) {
  return addToRedisOrInline('file-import', () => {
    void import('./workers/import.worker')
      .then(({ runImportJobInline }) => runImportJobInline(data))
      .catch((err) => logger.error({ err }, 'inline file-import failed'));
  }, () => importQueue.add('file-import', data, { priority: 5 }));
}

export async function enqueueEmail(data: EmailJobData) {
  return addToRedisOrInline('email', () => runEmailJobInBackground(data), () =>
    emailQueue.add('send-email', data),
  );
}

export async function enqueueGitHubProjectSync(data: Extract<GitHubJobData, { type: 'sync-project-link' }>) {
  return addToRedisOrInline(
    'github-sync',
    () => runGitHubJobInBackground(data),
    () =>
      githubQueue.add('sync-project-link', data, {
        jobId: `${data.projectGitHubLinkId}--${data.forceFull ? 'full' : 'delta'}--${data.lookbackDays ?? 'auto'}`,
      }),
  );
}

export async function enqueueGitHubIdentityRemap(data: Extract<GitHubJobData, { type: 'remap-project-identity' }>) {
  return addToRedisOrInline('github-remap', () => runGitHubJobInBackground(data), () =>
    githubQueue.add('remap-project-identity', data, {
      jobId: `${data.projectId}--${data.userId}--remap--${data.lookbackDays ?? 'auto'}`,
    }),
  );
}

export async function enqueueLegacySyncJobs(ticketIds: string[]) {
  if (getQueueMode() === 'inline' || !isRedisUsable()) {
    const { performLegacyCodemagenSync } = await import('../services/legacy-sync.service');
    for (const ticketId of ticketIds) {
      void performLegacyCodemagenSync(ticketId).catch((err) =>
        logger.error({ err, ticketId }, 'inline legacy-sync failed'),
      );
    }
    return ticketIds.map((id) => `inline-${id}`);
  }

  try {
    const jobs = await Promise.all(
      ticketIds.map((ticketId) => legacySyncQueue.add('codemagen-sync', { ticketId })),
    );
    return jobs.map((j) => j.id);
  } catch (err) {
    if (isRedisQuotaOrUnavailableError(err)) {
      markRedisUnusable(err, 'legacy-sync');
      if (!isRedisUsable()) {
        return enqueueLegacySyncJobs(ticketIds);
      }
    }
    throw err;
  }
}

export async function getQueueMetrics() {
  if (!isRedisUsable()) {
    return {
      'import-job': { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
      'email-job': { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
      'legacy-sync-job': { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
      'github-job': { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
      inlineMode: true,
    };
  }

  try {
    const [importCounts, emailCounts, legacyCounts, githubCounts] = await Promise.all([
      importQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      emailQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      legacySyncQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      githubQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
    ]);
    return {
      'import-job': importCounts,
      'email-job': emailCounts,
      'legacy-sync-job': legacyCounts,
      'github-job': githubCounts,
    };
  } catch (err) {
    if (isRedisQuotaOrUnavailableError(err)) {
      markRedisUnusable(err, 'getQueueMetrics');
    }
    return {
      'import-job': { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
      'email-job': { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
      'legacy-sync-job': { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
      'github-job': { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
      inlineMode: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
