import crypto from 'crypto';
import type { EmailEventType } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { enqueueTransactionalEmail } from './email-dispatch.service';
import {
  buildDailyTicketDigestEmail,
  buildTicketAssignmentEmail,
  buildTicketCommentEmail,
  buildTicketCreatedEmail,
  buildTicketUpdatedEmail,
} from './email-templates/ticket-email.templates';

function ticketUrl(ticketId: string) {
  const base = config.app.baseUrl.replace(/\/$/, '');
  return `${base}/tickets/${ticketId}`;
}

function fmt(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

type Recipient = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
};

function actorDisplayName(actor: { firstName?: string | null; lastName?: string | null } | null | undefined) {
  return `${actor?.firstName ?? ''} ${actor?.lastName ?? ''}`.trim() || 'Someone';
}

function fullName(user: { firstName: string; lastName: string }) {
  return `${user.firstName} ${user.lastName}`.trim();
}

function buildUpdateLines(
  updates: Record<string, unknown>,
  ticket: {
    title: string;
    workflowState: { name: string } | null;
    priority: string;
    type: string;
  },
  extras: { previousWorkflowStateName?: string | null },
): string[] {
  const lines: string[] = [];
  if (updates.title !== undefined) lines.push(`Title: ${fmt(updates.title)}`);
  if (updates.description !== undefined) lines.push('Description was updated.');
  if (updates.workflowStateId !== undefined) {
    const now = ticket.workflowState?.name ?? 'updated';
    if (extras.previousWorkflowStateName && extras.previousWorkflowStateName !== now) {
      lines.push(`Status / stage: ${extras.previousWorkflowStateName} → ${now}`);
    } else {
      lines.push(`Status / stage: ${now}`);
    }
  }
  if (updates.priority !== undefined) lines.push(`Priority: ${fmt(updates.priority)}`);
  if (updates.type !== undefined) lines.push(`Type: ${fmt(updates.type)}`);
  if (updates.sprintId !== undefined) lines.push('Sprint assignment changed.');
  if (updates.storyPoints !== undefined) lines.push(`Story points: ${fmt(updates.storyPoints)}`);
  if (updates.estimatedHours !== undefined) lines.push(`Estimated hours: ${fmt(updates.estimatedHours)}`);
  if (updates.dueDate !== undefined) lines.push(`Due date: ${fmt(updates.dueDate)}`);
  if (updates.module !== undefined) lines.push(`Module: ${fmt(updates.module)}`);
  if (updates.screen !== undefined) lines.push(`Screen: ${fmt(updates.screen)}`);
  if (updates.tags !== undefined) lines.push('Tags were updated.');
  if (updates.parentId !== undefined) lines.push('Parent ticket changed.');
  return lines;
}

async function pushNotification(input: {
  userId: string;
  title: string;
  body: string;
  emailQueued: boolean;
  eventType: EmailEventType;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}) {
  await prisma.notification.create({
    data: {
      userId: input.userId,
      type: 'INFO',
      title: input.title,
      body: input.body,
      channel: input.emailQueued ? 'both' : 'in_app',
      data: {
        eventType: input.eventType,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        ...input.metadata,
      },
    },
  });
}

function fingerprint(parts: Array<string | number | boolean | null | undefined>) {
  return crypto.createHash('sha1').update(parts.map((part) => String(part ?? '')).join('|')).digest('hex');
}

function recipientSlug(user: Recipient) {
  return user.email.split('@')[0].toLowerCase();
}

function recipientSearchTokens(user: Recipient) {
  return new Set(
    [
      recipientSlug(user),
      user.firstName,
      user.lastName,
      fullName(user),
      `${user.firstName}.${user.lastName}`,
      `${user.firstName}${user.lastName}`,
    ]
      .map((value) => value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))
      .filter(Boolean),
  );
}

function extractMentionTokens(body: string) {
  return Array.from(body.matchAll(/@([a-zA-Z0-9._-]+)/g)).map((match) => match[1].toLowerCase());
}

async function notifyUnassigned(params: {
  userId: string;
  actorName: string;
  ticketTitle: string;
  projectKey: string;
  ticketId: string;
}) {
  const user = await prisma.user.findFirst({
    where: { id: params.userId, deletedAt: null, status: 'ACTIVE' },
    select: { id: true, email: true, firstName: true },
  });
  if (!user) return;

  const subject = `[${params.projectKey}] Removed from ticket: ${params.ticketTitle}`;
  const link = ticketUrl(params.ticketId);
  const summary = [`${params.actorName} removed you from this ticket.`];
  const template = buildTicketAssignmentEmail({
    subject,
    actorName: params.actorName,
    projectKey: params.projectKey,
    ticketTitle: params.ticketTitle,
    link,
    changeSummary: summary,
    templateKey: 'ticket-unassigned',
    eyebrow: 'Removed',
    title: 'You were removed from a ticket',
  });
  const queue = await enqueueTransactionalEmail({
    userId: user.id,
    to: user.email,
    template,
    eventType: 'TICKET_UNASSIGNED',
    resourceType: 'ticket',
    resourceId: params.ticketId,
    fingerprint: fingerprint(['ticket-unassigned', params.ticketId, user.id]),
  });
  const text = `${params.actorName} removed you from this ticket.\n\n${params.ticketTitle}\n\nOpen: ${link}`;
  await pushNotification({
    userId: user.id,
    title: subject,
    body: text,
    emailQueued: queue.queued,
    eventType: 'TICKET_UNASSIGNED',
    resourceType: 'ticket',
    resourceId: params.ticketId,
  });
}

async function loadActor(actorId: string) {
  const actor = await prisma.user.findUnique({
    where: { id: actorId },
    select: { firstName: true, lastName: true },
  });
  return actorDisplayName(actor);
}

async function loadTicketContext(ticketId: string) {
  return prisma.ticket.findUnique({
    where: { id: ticketId },
    include: {
      assignees: { select: { id: true, email: true, firstName: true, lastName: true } },
      reporter: { select: { id: true, email: true, firstName: true, lastName: true } },
      watchers: {
        select: {
          user: { select: { id: true, email: true, firstName: true, lastName: true } },
        },
      },
      project: { select: { key: true, name: true } },
      workflowState: { select: { name: true, isFinal: true } },
    },
  });
}

function collectRecipients(ticket: NonNullable<Awaited<ReturnType<typeof loadTicketContext>>>, actorId: string, extraUsers: Recipient[] = []) {
  const map = new Map<string, Recipient>();
  for (const user of ticket.assignees) map.set(user.id, user);
  if (ticket.reporter) map.set(ticket.reporter.id, ticket.reporter);
  for (const watcher of ticket.watchers) map.set(watcher.user.id, watcher.user);
  for (const user of extraUsers) map.set(user.id, user);
  map.delete(actorId);
  return [...map.values()];
}

function resolveMentionedUsers(recipients: Recipient[], body: string) {
  const mentionTokens = extractMentionTokens(body);
  if (mentionTokens.length === 0) return new Set<string>();

  const matched = new Set<string>();
  for (const user of recipients) {
    const tokens = recipientSearchTokens(user);
    for (const mention of mentionTokens) {
      if (tokens.has(mention)) {
        matched.add(user.id);
      }
    }
  }
  return matched;
}

export async function notifyTicketCreated(ticketId: string, actorId: string) {
  try {
    const ticket = await loadTicketContext(ticketId);
    if (!ticket) return;

    const actorName = await loadActor(actorId);
    const recipients = collectRecipients(ticket, actorId);
    for (const user of recipients) {
      const subject = `[${ticket.project.key}] New ticket assigned: ${ticket.title}`;
      const link = ticketUrl(ticket.id);
      const intro =
        ticket.assignees.some((assignee) => assignee.id === user.id)
          ? [`${actorName} created a new ticket in ${ticket.project.name} and assigned it to you.`]
          : [`${actorName} created a new ticket in ${ticket.project.name}. You are receiving this as a reporter or watcher.`];
      const template = buildTicketCreatedEmail({
        subject,
        projectKey: ticket.project.key,
        ticketTitle: ticket.title,
        stageName: ticket.workflowState?.name ?? null,
        link,
        greeting: `Hello ${user.firstName},`,
        intro,
      });
      const queue = await enqueueTransactionalEmail({
        userId: user.id,
        to: user.email,
        template,
        eventType: 'TICKET_CREATED',
        resourceType: 'ticket',
        resourceId: ticket.id,
        fingerprint: fingerprint(['ticket-created', ticket.id, user.id, ticket.updatedAt.toISOString()]),
        metadata: { projectKey: ticket.project.key },
      });
      const statusLine = ticket.workflowState?.name ? ` Stage: ${ticket.workflowState.name}.` : '';
      const text = `${actorName} created a ticket.\n\n${ticket.title}${statusLine}\n\nOpen: ${link}`;
      await pushNotification({
        userId: user.id,
        title: subject,
        body: text,
        emailQueued: queue.queued,
        eventType: 'TICKET_CREATED',
        resourceType: 'ticket',
        resourceId: ticket.id,
        metadata: { recipientRole: ticket.assignees.some((assignee) => assignee.id === user.id) ? 'assignee' : 'watcher' },
      });
    }
  } catch (err) {
    logger.error({ err, ticketId }, 'notifyTicketCreated failed');
  }
}

export type NotifyTicketUpdatedOptions = {
  assigneeIdsApplied?: string[];
  previousWorkflowStateName?: string | null;
  previousWorkflowStateFinal?: boolean | null;
};

export async function notifyTicketUpdated(
  before: { assignees: { id: string }[] },
  ticketId: string,
  updates: Record<string, unknown>,
  actorId: string,
  opts?: NotifyTicketUpdatedOptions,
) {
  try {
    const ticket = await loadTicketContext(ticketId);
    if (!ticket) return;

    const oldIds = new Set(before.assignees.map((a) => a.id));
    const newIds = new Set(ticket.assignees.map((a) => a.id));

    const newlyAssignedIds = new Set(ticket.assignees.filter((a) => !oldIds.has(a.id)).map((a) => a.id));
    const removedIds = [...oldIds].filter((id) => !newIds.has(id));

    const actorName = await loadActor(actorId);

    let updateLines = buildUpdateLines(updates, ticket, {
      previousWorkflowStateName: opts?.previousWorkflowStateName ?? null,
    });

    if (opts?.assigneeIdsApplied !== undefined) {
      const summary =
        ticket.assignees.map((u) => `${u.firstName} ${u.lastName}`.trim()).join(', ') || 'Unassigned';
      updateLines.push(`Assigned people: ${summary}`);
    }

    const isCompleted =
      updates.workflowStateId !== undefined &&
      ticket.workflowState?.isFinal === true &&
      opts?.previousWorkflowStateFinal !== true;
    const isReopened =
      updates.workflowStateId !== undefined &&
      opts?.previousWorkflowStateFinal === true &&
      ticket.workflowState?.isFinal !== true;
    const hasMeaningfulUpdate = updateLines.length > 0 || isCompleted || isReopened;
    const recipients = collectRecipients(ticket, actorId);

    for (const rid of removedIds) {
      void notifyUnassigned({
        userId: rid,
        actorName,
        ticketTitle: ticket.title,
        projectKey: ticket.project.key,
        ticketId: ticket.id,
      });
    }

    for (const user of recipients) {
      const isNew = newlyAssignedIds.has(user.id);
      if (!isNew && !hasMeaningfulUpdate) continue;

      const parts: string[] = [];
      if (isNew) parts.push('You were added to this ticket.');
      parts.push(...updateLines);

      const link = ticketUrl(ticket.id);
      const bodyText = [`${actorName} updated ticket ${ticket.project.key}-${ticket.id.slice(0, 6)}.`, '', ...parts, '', `Open: ${link}`].join('\n');
      const eventType: EmailEventType = isNew
        ? 'TICKET_ASSIGNED'
        : isCompleted
          ? 'TICKET_COMPLETED'
          : isReopened
            ? 'TICKET_REOPENED'
            : 'TICKET_UPDATED';
      const subject = isNew
        ? `[${ticket.project.key}] Assigned: ${ticket.title}`
        : isCompleted
          ? `[${ticket.project.key}] Completed: ${ticket.title}`
          : isReopened
            ? `[${ticket.project.key}] Reopened: ${ticket.title}`
            : `[${ticket.project.key}] Ticket update: ${ticket.title}`;
      const template = isNew
        ? buildTicketAssignmentEmail({
            subject,
            actorName,
            projectKey: ticket.project.key,
            ticketTitle: ticket.title,
            link,
            changeSummary: parts,
            templateKey: 'ticket-assigned',
            eyebrow: 'Assignment',
            title: 'You were added to a ticket',
          })
        : buildTicketUpdatedEmail({
            subject,
            actorName,
            projectKey: ticket.project.key,
            ticketTitle: ticket.title,
            link,
            updateLines: parts,
            templateKey: isCompleted ? 'ticket-completed' : isReopened ? 'ticket-reopened' : 'ticket-updated',
            eyebrow: isCompleted ? 'Completed' : isReopened ? 'Reopened' : 'Update',
            note:
              isCompleted || isReopened
                ? 'Lifecycle analytics use workflow transitions, so this mail reflects the board state change that was just recorded.'
                : undefined,
          });
      const queue = await enqueueTransactionalEmail({
        userId: user.id,
        to: user.email,
        template,
        eventType,
        resourceType: 'ticket',
        resourceId: ticket.id,
        fingerprint: fingerprint([eventType, ticket.id, user.id, JSON.stringify(parts)]),
        metadata: { projectKey: ticket.project.key, isNewAssignee: isNew },
      });
      await pushNotification({
        userId: user.id,
        title: subject,
        body: bodyText,
        emailQueued: queue.queued,
        eventType,
        resourceType: 'ticket',
        resourceId: ticket.id,
        metadata: { isNewAssignee: isNew },
      });
    }
  } catch (err) {
    logger.error({ err, ticketId }, 'notifyTicketUpdated failed');
  }
}

export async function notifyTicketComment(params: {
  ticketId: string;
  actorId: string;
  commentPreview: string;
  commentBody?: string;
}) {
  const { ticketId, actorId, commentPreview, commentBody } = params;
  try {
    const ticket = await loadTicketContext(ticketId);
    if (!ticket) return;

    const actorName = await loadActor(actorId);
    const preview = commentPreview.length > 200 ? `${commentPreview.slice(0, 200)}…` : commentPreview;
    const link = ticketUrl(ticket.id);
    const recipients = collectRecipients(ticket, actorId);
    const mentionedUserIds = resolveMentionedUsers(recipients, commentBody ?? commentPreview);

    for (const user of recipients) {
      const subject = `[${ticket.project.key}] New comment: ${ticket.title}`;
      const text = `${actorName} commented:\n\n${preview}\n\nOpen: ${link}`;
      const mentioned = mentionedUserIds.has(user.id);
      const template = buildTicketCommentEmail({
        subject,
        actorName,
        projectKey: ticket.project.key,
        ticketTitle: ticket.title,
        link,
        preview,
        mentioned,
      });
      const queue = await enqueueTransactionalEmail({
        userId: user.id,
        to: user.email,
        template,
        eventType: 'TICKET_COMMENTED',
        resourceType: 'ticket',
        resourceId: ticket.id,
        fingerprint: fingerprint(['ticket-commented', ticket.id, user.id, preview, mentioned]),
        metadata: { projectKey: ticket.project.key, mentioned },
      });
      await pushNotification({
        userId: user.id,
        title: subject,
        body: text,
        emailQueued: queue.queued,
        eventType: 'TICKET_COMMENTED',
        resourceType: 'ticket',
        resourceId: ticket.id,
        metadata: { mentioned },
      });
    }
  } catch (err) {
    logger.error({ err, ticketId }, 'notifyTicketComment failed');
  }
}

export async function sendDailyTicketDigests() {
  const windowEnd = new Date();
  const users = await prisma.user.findMany({
    where: { status: 'ACTIVE', deletedAt: null },
    select: {
      id: true,
      email: true,
      firstName: true,
      emailPreferences: { select: { digestEnabled: true, lastDigestAt: true } },
    },
  });

  for (const user of users) {
    if (user.emailPreferences?.digestEnabled === false) continue;

    const windowStart =
      user.emailPreferences?.lastDigestAt ?? new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);
    const notifications = await prisma.notification.findMany({
      where: {
        userId: user.id,
        createdAt: { gt: windowStart, lte: windowEnd },
      },
      orderBy: { createdAt: 'desc' },
      take: 12,
      select: { title: true, body: true, createdAt: true },
    });

    if (notifications.length === 0) {
      await prisma.userEmailPreference.upsert({
        where: { userId: user.id },
        create: { userId: user.id, lastDigestAt: windowEnd },
        update: { lastDigestAt: windowEnd },
      });
      continue;
    }

    const items = notifications.map((notification) => {
      const summary = notification.body.split('\n').filter(Boolean)[0] ?? notification.title;
      return `${notification.createdAt.toISOString().slice(0, 16).replace('T', ' ')} - ${notification.title}: ${summary}`;
    });

    const template = buildDailyTicketDigestEmail({
      firstName: user.firstName,
      items,
      link: `${config.app.baseUrl}/tickets`,
    });

    await enqueueTransactionalEmail({
      userId: user.id,
      to: user.email,
      template,
      eventType: 'TICKET_DIGEST_DAILY',
      resourceType: 'digest',
      resourceId: user.id,
      fingerprint: fingerprint(['ticket-digest-daily', user.id, windowStart.toISOString(), windowEnd.toISOString()]),
      metadata: { itemCount: items.length },
    });

    await prisma.userEmailPreference.upsert({
      where: { userId: user.id },
      create: { userId: user.id, lastDigestAt: windowEnd },
      update: { lastDigestAt: windowEnd },
    });
  }
}
