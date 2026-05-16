import { Worker, Job } from 'bullmq';
import { redis } from '../../utils/redis';
import { logger } from '../../utils/logger';
import type { EmailJobData } from '../job-types';
import { config } from '../../utils/config';
import { runEmailJob } from '../processors/email.processor';
import { bullWorkerPollOptions, shouldRunBullWorkers } from '../queue-runtime';

let worker: Worker<EmailJobData> | null = null;

async function processEmailJob(job: Job<EmailJobData>) {
  return runEmailJob(job.data, { jobId: job.id });
}

export function startEmailWorker() {
  if (worker) return worker;
  if (!shouldRunBullWorkers()) {
    logger.info('email-worker: skipped (inline queue mode or Redis unavailable)');
    return null;
  }

  const concurrency = Math.max(1, Math.min(config.email.workerConcurrency, 5));

  worker = new Worker<EmailJobData>('email-job', processEmailJob, {
    connection: redis,
    concurrency,
    ...bullWorkerPollOptions(),
  });

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id }, 'email-worker: job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, to: job?.data?.to, err }, 'email-worker: job failed');
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'email-worker: worker error');
  });

  logger.info({ concurrency }, '✅ BullMQ email-job worker started');
  return worker;
}

export async function stopEmailWorker() {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('email-worker: stopped');
  }
}
