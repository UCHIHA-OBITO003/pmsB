import type { EmailJobData } from '../job-types';
import { sendHtmlEmail } from '../../services/email.service';
import { markEmailDeliveryResult, markEmailDeliverySkipped } from '../../services/email-dispatch.service';
import { logger } from '../../utils/logger';

/** Send one transactional email and update the delivery row (shared by worker + inline fallback). */
export async function runEmailJob(data: EmailJobData, meta?: { jobId?: string }) {
  const { deliveryId, to, subject, html, text, templateKey, eventType } = data;
  logger.info(
    { jobId: meta?.jobId ?? 'inline', deliveryId, to, subject, templateKey, eventType },
    'email: sending',
  );

  const result = await sendHtmlEmail(to, subject, html, text);

  if (!result.ok) {
    if (result.reason === 'no_transport') {
      await markEmailDeliverySkipped(deliveryId, 'No SMTP transport configured');
      logger.warn({ deliveryId, to, subject }, 'email: no SMTP transport, skipped');
      return { skipped: true as const, reason: 'no_transport' as const };
    }
    await markEmailDeliveryResult({ deliveryId, ok: false, detail: result.detail });
    throw new Error(`SMTP error: ${result.detail ?? 'unknown'}`);
  }

  await markEmailDeliveryResult({ deliveryId, ok: true, messageId: result.messageId });
  logger.info({ deliveryId, to, messageId: result.messageId }, 'email: accepted by SMTP');
  return { ok: true as const, messageId: result.messageId };
}

export function runEmailJobInBackground(data: EmailJobData): void {
  void runEmailJob(data, { jobId: 'inline' }).catch((err) => {
    logger.error({ err, deliveryId: data.deliveryId, to: data.to }, 'email: inline send failed');
  });
}
