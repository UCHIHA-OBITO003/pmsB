import { config } from '../../utils/config';

export type EmailEventKey =
  | 'password-reset-otp'
  | 'user-welcome'
  | 'user-profile-updated'
  | 'ticket-created'
  | 'ticket-assigned'
  | 'ticket-unassigned'
  | 'ticket-updated'
  | 'ticket-commented'
  | 'ticket-completed'
  | 'ticket-reopened'
  | 'ticket-digest-daily'
  | 'owner-analytics-report';

export type EmailTemplateResult = {
  templateKey: EmailEventKey;
  subject: string;
  html: string;
  text: string;
};

type EmailSection = {
  title?: string;
  lines: string[];
};

type EmailAction = {
  label: string;
  href: string;
};

type LayoutArgs = {
  preheader: string;
  eyebrow: string;
  title: string;
  greeting?: string;
  intro: string[];
  sections?: EmailSection[];
  action?: EmailAction;
  secondaryAction?: EmailAction;
  footer?: string[];
  note?: string;
};

const brand = {
  appName: 'PMS',
  orgName: 'Hanz.in',
  accent: '#0f766e',
  surface: '#0f172a',
  card: '#111827',
  border: '#1f2937',
  text: '#e5e7eb',
  textMuted: '#94a3b8',
};

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function paragraph(line: string) {
  return `<p style="margin:0 0 12px;color:${brand.text};font-size:15px;line-height:1.65">${escapeHtml(line)}</p>`;
}

function renderSection(section: EmailSection) {
  const heading = section.title
    ? `<h3 style="margin:0 0 10px;color:${brand.text};font-size:15px;font-weight:700">${escapeHtml(section.title)}</h3>`
    : '';

  const body = section.lines.map((line) => paragraph(line)).join('');
  return `
    <div style="margin-top:20px;padding:18px;border:1px solid ${brand.border};border-radius:14px;background:#0b1220">
      ${heading}
      ${body}
    </div>
  `;
}

function renderAction(action: EmailAction) {
  return `<a href="${escapeHtml(action.href)}" style="display:inline-block;padding:12px 18px;border-radius:12px;background:${brand.accent};color:#ffffff;text-decoration:none;font-weight:700;font-size:14px">${escapeHtml(action.label)}</a>`;
}

export function renderEmailLayout(args: LayoutArgs): { html: string; text: string } {
  const footerLines = args.footer ?? [
    `${brand.orgName} ${brand.appName}`,
    `Open ${brand.appName}: ${config.app.baseUrl}`,
    `If you were not expecting this message, you can safely ignore it.`,
  ];

  const html = `
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(args.preheader)}</div>
  <div style="margin:0;background:${brand.surface};padding:32px 16px;font-family:Inter,Segoe UI,Arial,sans-serif">
    <div style="max-width:640px;margin:0 auto;border-radius:24px;background:${brand.card};border:1px solid ${brand.border};overflow:hidden">
      <div style="padding:24px 28px;border-bottom:1px solid ${brand.border};background:linear-gradient(135deg, rgba(15,118,110,0.22), rgba(15,23,42,1))">
        <div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:${brand.textMuted};font-weight:700">${escapeHtml(args.eyebrow)}</div>
        <div style="margin-top:10px;font-size:28px;line-height:1.25;color:#fff;font-weight:800">${escapeHtml(args.title)}</div>
        ${args.greeting ? `<div style="margin-top:10px;font-size:15px;color:${brand.textMuted};line-height:1.6">${escapeHtml(args.greeting)}</div>` : ''}
      </div>
      <div style="padding:28px">
        ${args.intro.map((line) => paragraph(line)).join('')}
        ${args.sections?.map((section) => renderSection(section)).join('') ?? ''}
        ${
          args.action || args.secondaryAction
            ? `<div style="margin-top:24px;display:flex;gap:12px;flex-wrap:wrap">${
                args.action ? renderAction(args.action) : ''
              }${
                args.secondaryAction
                  ? `<a href="${escapeHtml(args.secondaryAction.href)}" style="display:inline-block;padding:12px 18px;border-radius:12px;border:1px solid ${brand.border};background:transparent;color:${brand.text};text-decoration:none;font-weight:600;font-size:14px">${escapeHtml(args.secondaryAction.label)}</a>`
                  : ''
              }</div>`
            : ''
        }
        ${
          args.note
            ? `<div style="margin-top:20px;padding:14px 16px;border-radius:14px;background:rgba(15,118,110,0.08);border:1px solid rgba(15,118,110,0.22);color:${brand.textMuted};font-size:13px;line-height:1.6">${escapeHtml(args.note)}</div>`
            : ''
        }
      </div>
      <div style="padding:20px 28px;border-top:1px solid ${brand.border};background:#0b1220">
        ${footerLines
          .map(
            (line) =>
              `<div style="margin:0 0 8px;color:${brand.textMuted};font-size:12px;line-height:1.5">${escapeHtml(line)}</div>`,
          )
          .join('')}
      </div>
    </div>
  </div>`;

  const text = [
    `${brand.orgName} ${brand.appName}`,
    '',
    args.title,
    args.greeting ? args.greeting : '',
    '',
    ...args.intro,
    '',
    ...(args.sections?.flatMap((section) => [section.title ?? '', ...section.lines, '']) ?? []),
    ...(args.action ? [`${args.action.label}: ${args.action.href}`] : []),
    ...(args.secondaryAction ? [`${args.secondaryAction.label}: ${args.secondaryAction.href}`] : []),
    ...(args.note ? ['', args.note] : []),
    '',
    ...footerLines,
  ]
    .filter((line, index, arr) => !(line === '' && arr[index - 1] === ''))
    .join('\n');

  return { html, text };
}
