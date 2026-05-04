import { config } from '../utils/config';
import { sendHtmlEmail } from './email.service';

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function sendWelcomeCredentialsEmail(params: {
  to: string;
  firstName: string;
  email: string;
  temporaryPassword: string;
}) {
  const loginUrl = `${config.app.baseUrl}/login`;
  const subject = `Your account — ${config.app.baseUrl.replace(/^https?:\/\//, '')}`;
  const text = [
    `Hello ${params.firstName},`,
    '',
    `An administrator created your PMS account.`,
    '',
    `Sign in URL: ${loginUrl}`,
    `Email / username: ${params.email}`,
    `Temporary password: ${params.temporaryPassword}`,
    '',
    'Please change your password after first login.',
  ].join('\n');

  const html = `
<p>Hello <strong>${escapeHtml(params.firstName)}</strong>,</p>
<p>An administrator created your account on the Delivery OS platform.</p>
<p><strong>Website:</strong><br/><a href="${loginUrl}">${escapeHtml(loginUrl)}</a></p>
<p><strong>Login email:</strong> ${escapeHtml(params.email)}<br/>
<strong>Temporary password:</strong> <code>${escapeHtml(params.temporaryPassword)}</code></p>
<p>For security, sign in and change your password under <em>Settings</em>.</p>
`;

  return sendHtmlEmail(params.to, subject, html, text);
}

export async function sendAdminProfileNotificationEmail(params: {
  to: string;
  firstName: string;
  lines: string[];
  plainPasswordSent?: boolean;
  newPasswordPlain?: string;
}) {
  const loginUrl = `${config.app.baseUrl}/login`;
  const subject = `Your profile was updated — ${config.app.baseUrl.replace(/^https?:\/\//, '')}`;
  const pwBlock =
    params.plainPasswordSent && params.newPasswordPlain
      ? `\nNew password: ${params.newPasswordPlain}\n`
      : params.plainPasswordSent
        ? '\nYour password was reset. Use the link below to sign in; use Forgot password if you need a code.\n'
        : '';
  const text = [
    `Hello ${params.firstName},`,
    '',
    `Your administrator updated your profile:`,
    params.lines.map((l) => `- ${l}`).join('\n'),
    pwBlock,
    `Sign in: ${loginUrl}`,
    `Your login email: ${params.to}`,
    '',
    'You can reset your password from the login page using the email code if needed.',
  ].join('\n');

  const html = `
<p>Hello <strong>${escapeHtml(params.firstName)}</strong>,</p>
<p>An administrator updated your account:</p>
<ul>${params.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
${
  params.plainPasswordSent && params.newPasswordPlain
    ? `<p><strong>New password:</strong> <code>${escapeHtml(params.newPasswordPlain)}</code></p>`
    : params.plainPasswordSent
      ? '<p>Your login password was changed. Sign in below and change it under Settings when you can.</p>'
      : ''
}
<p><strong>Website:</strong> <a href="${loginUrl}">${escapeHtml(loginUrl)}</a></p>
<p><strong>Login email:</strong> ${escapeHtml(params.to)}</p>
`;

  return sendHtmlEmail(params.to, subject, html, text);
}
