import { Worker, Job } from 'bullmq';
import { redis } from '../../utils/redis';
import { logger } from '../../utils/logger';
import type { LegacySyncJobData } from '../index';
import { performLegacyCodemagenSync } from '../../services/legacy-sync.service';

let worker: Worker<LegacySyncJobData> | null = null;

async function processLegacySync(job: Job<LegacySyncJobData>) {
  const { ticketId } = job.data;
  logger.info({ jobId: job.id, ticketId }, 'legacy-sync-worker: scraping Codemagen');
  await performLegacyCodemagenSync(ticketId);
}

export function startLegacySyncWorker() {
  if (worker) return worker;

  worker = new Worker<LegacySyncJobData>('legacy-sync-job', processLegacySync, {
    connection: redis,
    concurrency: 2,
  });

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, ticketId: job.data.ticketId }, 'legacy-sync-worker: completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, ticketId: job?.data?.ticketId, err }, 'legacy-sync-worker: failed');
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'legacy-sync-worker: worker error');
  });

  logger.info('✅ BullMQ legacy-sync-job worker started (concurrency=2)');
  return worker;
}

export async function stopLegacySyncWorker() {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('legacy-sync-worker: stopped');
  }
}
