import { Job, Worker } from 'bullmq';
import { redis } from '../../utils/redis';
import { logger } from '../../utils/logger';
import { type GitHubJobData } from '../index';
import { remapProjectGitHubIdentity, syncProjectGitHubLink } from '../../services/github.service';

let worker: Worker<GitHubJobData> | null = null;

async function processGitHubJob(job: Job<GitHubJobData>) {
  if (job.data.type === 'sync-project-link') {
    logger.info({ jobId: job.id, projectGitHubLinkId: job.data.projectGitHubLinkId }, 'github-worker: syncing project link');
    await syncProjectGitHubLink(job.data.projectGitHubLinkId, Boolean(job.data.forceFull), job.data.lookbackDays);
    return { ok: true };
  }

  if (job.data.type === 'remap-project-identity') {
    logger.info({ jobId: job.id, projectId: job.data.projectId, userId: job.data.userId }, 'github-worker: remapping project identity');
    return remapProjectGitHubIdentity(job.data.projectId, job.data.userId, job.data.lookbackDays ?? 90);
  }

  return { skipped: true, reason: 'unknown_job_type' };
}

export function startGitHubWorker() {
  if (worker) return worker;

  worker = new Worker<GitHubJobData>('github-job', processGitHubJob, {
    connection: redis,
    concurrency: 2,
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
