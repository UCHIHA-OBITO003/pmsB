import type { EmailDeliveryStatus, EmailEventType, Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { enqueueEmail } from '../queues';
import { logger } from '../utils/logger';
import { smtpCredentialsPresent } from './email.service';
import { shouldSendEmailEvent } from './email-preferences.service';
import type { EmailTemplateResult } from './email-templates/core';

export type QueueEmailResult =
  | { queued: true; deliveryId: string; smtpConfigured: boolean }
  | { queued: false; deliveryId?: string; smtpConfigured: boolean; reason: 'preferences_disabled' | 'duplicate' };

type QueueEmailInput = {
  userId?: string;
  to: string;
  template: EmailTemplateResult;
  eventType: EmailEventType;
  resourceType?: string;
  resourceId?: string;
  fingerprint?: string;
  metadata?: Prisma.InputJsonValue;
  bypassPreferences?: boolean;
};

const DEDUPE_WINDOW_MS = 5 * 60 * 1000;

function deliveryMetadata(input: QueueEmailInput): Prisma.InputJsonValue {
  const base =
    typeof input.metadata === 'object' && input.metadata !== null && !Array.isArray(input.metadata)
      ? { ...(input.metadata as Record<string, unknown>) }
      : {};
  return {
    ...base,
    html: input.template.html,
    text: input.template.text,
  } as Prisma.InputJsonValue;
}

async function createDeliveryRow(input: QueueEmailInput, status: EmailDeliveryStatus, errorDetail?: string) {
  return prisma.emailDelivery.create({
    data: {
      userId: input.userId,
      to: input.to,
      subject: input.template.subject,
      templateKey: input.template.templateKey,
      eventType: input.eventType,
      status,
      errorDetail,
      fingerprint: input.fingerprint,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      metadata: deliveryMetadata(input),
      ...(status === 'SKIPPED' ? { failedAt: new Date() } : {}),
    },
    select: { id: true },
  });
}

export async function enqueueTransactionalEmail(input: QueueEmailInput): Promise<QueueEmailResult> {
  const smtpConfigured = smtpCredentialsPresent();

  if (!input.bypassPreferences && !(await shouldSendEmailEvent(input.userId, input.eventType))) {
    const skipped = await createDeliveryRow(input, 'SKIPPED', 'User preferences disabled this email class');
    return { queued: false, deliveryId: skipped.id, smtpConfigured, reason: 'preferences_disabled' };
  }

  if (input.fingerprint) {
    const existing = await prisma.emailDelivery.findFirst({
      where: {
        fingerprint: input.fingerprint,
        queuedAt: { gte: new Date(Date.now() - DEDUPE_WINDOW_MS) },
        status: { in: ['QUEUED', 'SENT'] },
      },
      select: { id: true },
      orderBy: { queuedAt: 'desc' },
    });
    if (existing) {
      return { queued: false, deliveryId: existing.id, smtpConfigured, reason: 'duplicate' };
    }
  }

  const delivery = await createDeliveryRow(input, 'QUEUED');
  await enqueueEmail({
    deliveryId: delivery.id,
    userId: input.userId,
    to: input.to,
    subject: input.template.subject,
    html: input.template.html,
    text: input.template.text,
    templateKey: input.template.templateKey,
    eventType: input.eventType,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    metadata: typeof input.metadata === 'object' && input.metadata !== null ? (input.metadata as Record<string, unknown>) : undefined,
  });

  logger.info(
    { deliveryId: delivery.id, to: input.to, eventType: input.eventType, templateKey: input.template.templateKey },
    'Transactional email queued',
  );

  return { queued: true, deliveryId: delivery.id, smtpConfigured };
}

export async function markEmailDeliveryResult(args: {
  deliveryId: string;
  ok: boolean;
  messageId?: string;
  detail?: string;
}): Promise<void> {
  await prisma.emailDelivery.update({
    where: { id: args.deliveryId },
    data: args.ok
      ? {
          status: 'SENT',
          messageId: args.messageId,
          sentAt: new Date(),
          errorDetail: null,
        }
      : {
          status: 'FAILED',
          errorDetail: args.detail ?? 'Unknown email send failure',
          failedAt: new Date(),
        },
  });
}

export async function markEmailDeliverySkipped(deliveryId: string, detail: string): Promise<void> {
  await prisma.emailDelivery.update({
    where: { id: deliveryId },
    data: {
      status: 'SKIPPED',
      errorDetail: detail,
      failedAt: new Date(),
    },
  });
}
