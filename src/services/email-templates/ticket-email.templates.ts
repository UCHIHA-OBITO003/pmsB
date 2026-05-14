import { renderEmailLayout, type EmailTemplateResult } from './core';

type TicketTemplateArgs = {
  subject: string;
  templateKey: EmailTemplateResult['templateKey'];
  eyebrow: string;
  title: string;
  greeting?: string;
  intro: string[];
  sections?: { title?: string; lines: string[] }[];
  actionLabel?: string;
  actionHref: string;
  note?: string;
};

function buildTicketEmail(args: TicketTemplateArgs): EmailTemplateResult {
  const rendered = renderEmailLayout({
    preheader: args.title,
    eyebrow: args.eyebrow,
    title: args.title,
    greeting: args.greeting,
    intro: args.intro,
    sections: args.sections,
    action: { label: args.actionLabel ?? 'Open ticket', href: args.actionHref },
    note: args.note,
  });

  return {
    templateKey: args.templateKey,
    subject: args.subject,
    html: rendered.html,
    text: rendered.text,
  };
}

export function buildTicketCreatedEmail(args: {
  subject: string;
  projectKey: string;
  ticketTitle: string;
  stageName?: string | null;
  link: string;
  intro: string[];
  greeting?: string;
}): EmailTemplateResult {
  return buildTicketEmail({
    templateKey: 'ticket-created',
    subject: args.subject,
    eyebrow: `${args.projectKey} · New ticket`,
    title: args.ticketTitle,
    greeting: args.greeting,
    intro: args.intro,
    sections: [
      {
        title: 'Current stage',
        lines: [args.stageName ?? 'Unspecified'],
      },
    ],
    actionHref: args.link,
  });
}

export function buildTicketAssignmentEmail(args: {
  subject: string;
  actorName: string;
  projectKey: string;
  ticketTitle: string;
  link: string;
  changeSummary: string[];
  templateKey: 'ticket-assigned' | 'ticket-unassigned';
  eyebrow: string;
  title: string;
}): EmailTemplateResult {
  return buildTicketEmail({
    templateKey: args.templateKey,
    subject: args.subject,
    eyebrow: `${args.projectKey} · ${args.eyebrow}`,
    title: args.title,
    greeting: `Update from ${args.actorName}`,
    intro: [args.ticketTitle],
    sections: args.changeSummary.length > 0 ? [{ title: 'Summary', lines: args.changeSummary }] : undefined,
    actionHref: args.link,
  });
}

export function buildTicketUpdatedEmail(args: {
  subject: string;
  actorName: string;
  projectKey: string;
  ticketTitle: string;
  link: string;
  updateLines: string[];
  note?: string;
  templateKey: 'ticket-updated' | 'ticket-completed' | 'ticket-reopened';
  eyebrow: string;
}): EmailTemplateResult {
  return buildTicketEmail({
    templateKey: args.templateKey,
    subject: args.subject,
    eyebrow: `${args.projectKey} · ${args.eyebrow}`,
    title: args.ticketTitle,
    greeting: `Updated by ${args.actorName}`,
    intro: ['The ticket changed. Review the summary below.'],
    sections: [{ title: 'What changed', lines: args.updateLines }],
    actionHref: args.link,
    note: args.note,
  });
}

export function buildTicketCommentEmail(args: {
  subject: string;
  actorName: string;
  projectKey: string;
  ticketTitle: string;
  link: string;
  preview: string;
  mentioned?: boolean;
}): EmailTemplateResult {
  return buildTicketEmail({
    templateKey: 'ticket-commented',
    subject: args.subject,
    eyebrow: `${args.projectKey} · New comment`,
    title: args.ticketTitle,
    greeting: `Comment from ${args.actorName}`,
    intro: [args.mentioned ? 'You were mentioned in a ticket comment.' : 'There is a new comment on this ticket.'],
    sections: [{ title: 'Comment preview', lines: [args.preview] }],
    actionHref: args.link,
  });
}

export function buildDailyTicketDigestEmail(args: {
  firstName: string;
  items: string[];
  link: string;
}): EmailTemplateResult {
  const subject = `Your daily PMS activity summary`;
  return buildTicketEmail({
    templateKey: 'ticket-digest-daily',
    subject,
    eyebrow: 'Daily digest',
    title: 'Ticket activity summary',
    greeting: `Hello ${args.firstName},`,
    intro: ['Here is the latest ticket activity collected for you since the last digest.'],
    sections: [{ title: 'Highlights', lines: args.items }],
    actionHref: args.link,
    actionLabel: 'Open PMS',
    note: 'Instant email notifications still cover security and important ticket events.',
  });
}
