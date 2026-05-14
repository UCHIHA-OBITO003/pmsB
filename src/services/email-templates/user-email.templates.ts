import { config } from '../../utils/config';
import { renderEmailLayout, type EmailTemplateResult } from './core';

export function buildWelcomeCredentialsEmail(args: {
  firstName: string;
  email: string;
  temporaryPassword: string;
}): EmailTemplateResult {
  const loginUrl = `${config.app.baseUrl}/login`;
  const subject = `Your ${config.app.baseUrl.replace(/^https?:\/\//, '')} account is ready`;
  const rendered = renderEmailLayout({
    preheader: 'Your PMS account is ready.',
    eyebrow: 'Account access',
    title: 'Welcome to PMS',
    greeting: `Hello ${args.firstName},`,
    intro: [
      'An administrator created your PMS account.',
      'Use the credentials below to sign in and change your password after your first login.',
    ],
    sections: [
      {
        title: 'Sign-in details',
        lines: [
          `Login email: ${args.email}`,
          `Temporary password: ${args.temporaryPassword}`,
        ],
      },
    ],
    action: { label: 'Sign in', href: loginUrl },
    note: 'Store the temporary password safely. You can reset it later from the sign-in page if needed.',
  });

  return {
    templateKey: 'user-welcome',
    subject,
    html: rendered.html,
    text: rendered.text,
  };
}

export function buildAdminProfileUpdatedEmail(args: {
  firstName: string;
  email: string;
  lines: string[];
  newPasswordPlain?: string;
  passwordChanged?: boolean;
}): EmailTemplateResult {
  const loginUrl = `${config.app.baseUrl}/login`;
  const subject = `Your PMS profile was updated`;
  const sections = [
    {
      title: 'What changed',
      lines: args.lines.length > 0 ? args.lines : ['Your administrator updated your account settings.'],
    },
  ];

  if (args.newPasswordPlain) {
    sections.push({
      title: 'Temporary password',
      lines: [`New password: ${args.newPasswordPlain}`],
    });
  }

  const rendered = renderEmailLayout({
    preheader: 'Your account details were updated.',
    eyebrow: 'Account update',
    title: 'Profile changes saved',
    greeting: `Hello ${args.firstName},`,
    intro: [
      'An administrator updated your PMS account.',
      args.passwordChanged
        ? 'If your password was changed, sign in again and rotate it as soon as possible.'
        : 'Review the summary below to confirm the changes look correct.',
    ],
    sections,
    action: { label: 'Sign in', href: loginUrl },
    note: `Your current sign-in email is ${args.email}. Use Forgot password if you need a new reset code.`,
  });

  return {
    templateKey: 'user-profile-updated',
    subject,
    html: rendered.html,
    text: rendered.text,
  };
}
