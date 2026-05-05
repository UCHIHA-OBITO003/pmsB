import { Worker, Job } from 'bullmq';
import { redis } from '../../utils/redis';
import { logger } from '../../utils/logger';
import { EmailJobData } from '../index';
import { sendHtmlEmail } from '../../services/email.service';

let worker: Worker<EmailJobData> | null = null;

async function processEmailJob(job: Job<EmailJobData>) {
  const { to, subject, html, text } = job.data;
  logger.info({ jobId: job.id, to, subject }, 'email-worker: sending email');

  const result = await sendHtmlEmail(to, subject, html, text);

  if (!result.ok) {
    if (result.reason === 'no_transport') {
      // SMTP is unconfigured — don't retry, just log and discard
      logger.warn({ jobId: job.id, to, subject }, 'email-worker: no SMTP transport, discarding job');
      return { skipped: true, reason: 'no_transport' };
    }
    // SMTP error — let BullMQ retry according to the queue's backoff policy
    throw new Error(`SMTP error: ${result.detail ?? 'unknown'}`);
  }

  logger.info({ jobId: job.id, to, messageId: result.messageId }, 'email-worker: email accepted by SMTP');
  return { ok: true, messageId: result.messageId };
}

export function startEmailWorker() {
  if (worker) return worker;

  worker = new Worker<EmailJobData>('email-job', processEmailJob, {
    connection: redis,
    concurrency: 5,
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

  logger.info('✅ BullMQ email-job worker started (concurrency=5)');
  return worker;
}

export async function stopEmailWorker() {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('email-worker: stopped');
  }
}
