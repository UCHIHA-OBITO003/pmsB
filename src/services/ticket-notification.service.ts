import { prisma } from '../utils/prisma';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { sendHtmlEmail } from './email.service';

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

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
  emailSent: boolean;
}) {
  await prisma.notification.create({
    data: {
      userId: input.userId,
      type: 'INFO',
      title: input.title,
      body: input.body,
      channel: input.emailSent ? 'both' : 'in_app',
      sentAt: input.emailSent ? new Date() : null,
    },
  });
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
  const text = `${params.actorName} removed you from this ticket.\n\n${params.ticketTitle}\n\nOpen: ${link}`;
  const html = `<p><strong>${escapeHtml(params.actorName)}</strong> removed you from:</p>
<p>${escapeHtml(params.ticketTitle)}</p>
<p><a href="${link}">View ticket</a></p>`;

  const mail = await sendHtmlEmail(user.email, subject, html, text);
  await pushNotification({
    userId: user.id,
    title: subject,
    body: text,
    emailSent: mail.ok,
  });
}

export async function notifyTicketCreated(ticketId: string, actorId: string) {
  try {
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        assignees: { select: { id: true, email: true, firstName: true, lastName: true } },
        project: { select: { key: true, name: true } },
        workflowState: { select: { name: true, isFinal: true } },
      },
    });
    if (!ticket || ticket.assignees.length === 0) return;

    const actor = await prisma.user.findUnique({
      where: { id: actorId },
      select: { firstName: true, lastName: true },
    });
    const actorName = actor ? `${actor.firstName} ${actor.lastName}`.trim() : 'Someone';

    const statusLine = ticket.workflowState?.name ? ` Stage: ${ticket.workflowState.name}.` : '';

    for (const user of ticket.assignees) {
      if (user.id === actorId) continue;

      const subject = `[${ticket.project.key}] New ticket assigned: ${ticket.title}`;
      const link = ticketUrl(ticket.id);
      const text = `${actorName} assigned you to a ticket.\n\n${ticket.title}${statusLine}\n\nOpen: ${link}`;
      const html = `<p><strong>${escapeHtml(actorName)}</strong> assigned you to a ticket.</p>
<p><strong>${escapeHtml(ticket.project.name)}</strong> (${escapeHtml(ticket.project.key)})</p>
<p>${escapeHtml(ticket.title)}</p>
${ticket.workflowState ? `<p><strong>Stage:</strong> ${escapeHtml(ticket.workflowState.name)}</p>` : ''}
<p><a href="${link}">Open ticket</a></p>`;

      const mail = await sendHtmlEmail(user.email, subject, html, text);
      await pushNotification({
        userId: user.id,
        title: subject,
        body: text,
        emailSent: mail.ok,
      });
    }
  } catch (err) {
    logger.error({ err, ticketId }, 'notifyTicketCreated failed');
  }
}

export type NotifyTicketUpdatedOptions = {
  assigneeIdsApplied?: string[];
  previousWorkflowStateName?: string | null;
};

export async function notifyTicketUpdated(
  before: { assignees: { id: string }[] },
  ticketId: string,
  updates: Record<string, unknown>,
  actorId: string,
  opts?: NotifyTicketUpdatedOptions,
) {
  try {
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        assignees: { select: { id: true, email: true, firstName: true, lastName: true } },
        project: { select: { key: true, name: true } },
        workflowState: { select: { name: true, isFinal: true } },
      },
    });
    if (!ticket) return;

    const oldIds = new Set(before.assignees.map((a) => a.id));
    const newIds = new Set(ticket.assignees.map((a) => a.id));

    const newlyAssignedIds = new Set(ticket.assignees.filter((a) => !oldIds.has(a.id)).map((a) => a.id));
    const removedIds = [...oldIds].filter((id) => !newIds.has(id));

    const actor = await prisma.user.findUnique({
      where: { id: actorId },
      select: { firstName: true, lastName: true },
    });
    const actorName = actor ? `${actor.firstName} ${actor.lastName}`.trim() : 'Someone';

    let updateLines = buildUpdateLines(updates, ticket, {
      previousWorkflowStateName: opts?.previousWorkflowStateName ?? null,
    });

    if (opts?.assigneeIdsApplied !== undefined) {
      const summary =
        ticket.assignees.map((u) => `${u.firstName} ${u.lastName}`.trim()).join(', ') || 'Unassigned';
      updateLines.push(`Assigned people: ${summary}`);
    }

    const hasMeaningfulUpdate = updateLines.length > 0;

    for (const rid of removedIds) {
      void notifyUnassigned({
        userId: rid,
        actorName,
        ticketTitle: ticket.title,
        projectKey: ticket.project.key,
        ticketId: ticket.id,
      });
    }

    for (const user of ticket.assignees) {
      if (user.id === actorId) continue;

      const isNew = newlyAssignedIds.has(user.id);
      if (!isNew && !hasMeaningfulUpdate) continue;

      const parts: string[] = [];
      if (isNew) parts.push('You were added to this ticket.');
      parts.push(...updateLines);

      const bodyText = [`${actorName} updated ticket ${ticket.project.key}-${ticket.id.slice(0, 6)}.`, '', ...parts, '', `Open: ${ticketUrl(ticket.id)}`].join('\n');

      const milestone =
        ticket.workflowState?.isFinal && updates.workflowStateId !== undefined
          ? ` · ${ticket.workflowState.name}`
          : '';
      const subject = `[${ticket.project.key}] Ticket update${milestone}: ${ticket.title}`;

      const link = ticketUrl(ticket.id);
      const html = `<p><strong>${escapeHtml(actorName)}</strong> updated this ticket.</p>
<ul>${parts.filter(Boolean).map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
<p><a href="${link}">Open ticket</a></p>`;

      const mail = await sendHtmlEmail(user.email, subject, html, bodyText);
      await pushNotification({
        userId: user.id,
        title: subject,
        body: bodyText,
        emailSent: mail.ok,
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
}) {
  const { ticketId, actorId, commentPreview } = params;
  try {
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        assignees: { select: { id: true, email: true, firstName: true, lastName: true } },
        project: { select: { key: true, name: true } },
      },
    });
    if (!ticket) return;

    const actor = await prisma.user.findUnique({
      where: { id: actorId },
      select: { firstName: true, lastName: true },
    });
    const actorName = actor ? `${actor.firstName} ${actor.lastName}`.trim() : 'Someone';
    const preview = commentPreview.length > 200 ? `${commentPreview.slice(0, 200)}…` : commentPreview;
    const link = ticketUrl(ticket.id);

    for (const user of ticket.assignees) {
      if (user.id === actorId) continue;

      const subject = `[${ticket.project.key}] New comment: ${ticket.title}`;
      const text = `${actorName} commented:\n\n${preview}\n\nOpen: ${link}`;
      const html = `<p><strong>${escapeHtml(actorName)}</strong> commented:</p>
<blockquote style="border-left:3px solid #ccc;padding-left:12px">${escapeHtml(preview)}</blockquote>
<p><a href="${link}">View ticket</a></p>`;

      const mail = await sendHtmlEmail(user.email, subject, html, text);
      await pushNotification({
        userId: user.id,
        title: subject,
        body: text,
        emailSent: mail.ok,
      });
    }
  } catch (err) {
    logger.error({ err, ticketId }, 'notifyTicketComment failed');
  }
}
