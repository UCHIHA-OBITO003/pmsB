import { prisma } from '../utils/prisma';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { runEmailJob } from '../queues/processors/email.processor';
import type { EmailJobData } from '../queues/job-types';

const STUCK_QUEUED_MS = 60_000;

/** Process email deliveries left QUEUED when Redis/BullMQ was unavailable. */
export async function drainStuckQueuedEmailDeliveries(): Promise<number> {
  if (!config.features.email) return 0;

  const batch = Math.max(1, Math.min(config.queues.emailDrainBatchSize, 20));
  const cutoff = new Date(Date.now() - STUCK_QUEUED_MS);

  const rows = await prisma.emailDelivery.findMany({
    where: {
      status: 'QUEUED',
      queuedAt: { lte: cutoff },
    },
    orderBy: { queuedAt: 'asc' },
    take: batch,
    select: {
      id: true,
      userId: true,
      to: true,
      subject: true,
      templateKey: true,
      eventType: true,
      resourceType: true,
      resourceId: true,
      metadata: true,
    },
  });

  if (!rows.length) return 0;

  let processed = 0;
  for (const row of rows) {
    const meta =
      row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : undefined;
    const html = typeof meta?.html === 'string' ? meta.html : '';
    const text = typeof meta?.text === 'string' ? meta.text : '';

    if (!html && !text) {
      logger.warn({ deliveryId: row.id }, 'email-drain: missing html/text in metadata — cannot resend');
      continue;
    }

    const job: EmailJobData = {
      deliveryId: row.id,
      userId: row.userId ?? undefined,
      to: row.to,
      subject: row.subject,
      html,
      text: text || row.subject,
      templateKey: row.templateKey,
      eventType: row.eventType,
      resourceType: row.resourceType ?? undefined,
      resourceId: row.resourceId ?? undefined,
      metadata: meta,
    };

    try {
      await runEmailJob(job, { jobId: 'drain' });
      processed += 1;
    } catch (err) {
      logger.error({ err, deliveryId: row.id }, 'email-drain: send failed');
    }
  }

  if (processed > 0) {
    logger.info({ processed, found: rows.length }, 'email-drain: recovered stuck QUEUED deliveries');
  }

  return processed;
}
