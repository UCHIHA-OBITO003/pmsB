import { config } from '../../utils/config';
import { renderEmailLayout, type EmailTemplateResult } from './core';

export function buildPasswordResetOtpEmail(args: {
  firstName: string;
  email: string;
  otp: string;
}): EmailTemplateResult {
  const resetUrl = `${config.app.baseUrl}/reset-password?email=${encodeURIComponent(args.email)}`;
  const subject = `Password reset code for ${config.app.baseUrl.replace(/^https?:\/\//, '')}`;
  const rendered = renderEmailLayout({
    preheader: `Use ${args.otp} to reset your password.`,
    eyebrow: 'Security',
    title: 'Reset your password',
    greeting: `Hello ${args.firstName},`,
    intro: [
      'We received a request to reset your PMS password.',
      'Use the one-time verification code below to continue. It expires in 15 minutes.',
    ],
    sections: [
      {
        title: 'Verification code',
        lines: [args.otp],
      },
      {
        title: 'Need help?',
        lines: [
          'If you did not request this reset, you can ignore this email and your password will remain unchanged.',
        ],
      },
    ],
    action: { label: 'Open reset page', href: resetUrl },
    secondaryAction: { label: 'Back to sign in', href: `${config.app.baseUrl}/login` },
    note: 'For security, never share this code with anyone.',
  });

  return {
    templateKey: 'password-reset-otp',
    subject,
    html: rendered.html,
    text: rendered.text,
  };
}
