import { Job, Worker } from 'bullmq';
import { redis } from '../../utils/redis';
import { logger } from '../../utils/logger';
import type { GitHubJobData } from '../job-types';
import { runGitHubJob } from '../processors/github.processor';
import { bullWorkerPollOptions, shouldRunBullWorkers } from '../queue-runtime';

let worker: Worker<GitHubJobData> | null = null;

async function processGitHubJob(job: Job<GitHubJobData>) {
  return runGitHubJob(job.data, { jobId: job.id });
}

export function startGitHubWorker() {
  if (worker) return worker;
  if (!shouldRunBullWorkers()) {
    logger.info('github-worker: skipped (inline queue mode or Redis unavailable)');
    return null;
  }

  worker = new Worker<GitHubJobData>('github-job', processGitHubJob, {
    connection: redis,
    concurrency: 2,
    ...bullWorkerPollOptions(),
  });

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id }, 'github-worker: job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'github-worker: job failed');
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'github-worker: worker error');
  });

  logger.info('✅ BullMQ github-job worker started (concurrency=2)');
  return worker;
}

export async function stopGitHubWorker() {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('github-worker: stopped');
  }
}
