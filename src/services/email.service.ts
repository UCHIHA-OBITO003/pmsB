import nodemailer from 'nodemailer';
import { config } from '../utils/config';
import { logger } from '../utils/logger';

let transporter: nodemailer.Transporter | null | undefined;

/** True when transactional mail can be attempted (SMTP credentials present). */
export function smtpCredentialsPresent(): boolean {
  return !!(config.email.user?.trim() && config.email.pass?.trim());
}

export type EmailSendResult =
  | { ok: true; messageId?: string }
  | { ok: false; reason: 'no_transport' | 'smtp_error'; detail?: string };

/** Safe to return to the admin UI (no stacks). `ok:true` means SMTP accepted the message, not inbox delivery. */
export function emailDeliveryForClient(r: EmailSendResult): {
  ok: boolean;
  reason?: 'no_transport' | 'smtp_error';
  detail?: string;
  messageId?: string;
} {
  if (r.ok) {
    return { ok: true, messageId: r.messageId };
  }
  return { ok: false, reason: r.reason, detail: r.detail };
}

function smtpFailureDetail(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & {
    code?: string;
    responseCode?: number;
    response?: string;
    command?: string;
  };
  const parts = [e.message];
  if (e.code) parts.push(`code=${e.code}`);
  if (e.responseCode != null) parts.push(`responseCode=${e.responseCode}`);
  if (e.response) parts.push(`response=${String(e.response).slice(0, 500)}`);
  if (e.command) parts.push(`command=${e.command}`);
  return parts.join(' | ');
}

function getTransporter(): nodemailer.Transporter | null {
  if (transporter !== undefined) return transporter;

  if (!smtpCredentialsPresent()) {
    transporter = null;
    return null;
  }

  transporter = nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.port === 465,
    auth: {
      user: config.email.user,
      pass: config.email.pass,
    },
    connectionTimeout: config.email.connectionTimeoutMs,
    greetingTimeout: config.email.greetingTimeoutMs,
    socketTimeout: config.email.socketTimeoutMs,
    // Port 587: upgrade with STARTTLS (Gmail / most hosts). Harmless when unused.
    requireTLS: config.email.port === 587,
    ...(config.email.forceIpv4 ? ({ family: 4 } as { family: number }) : {}),
    ...(process.env.SMTP_DEBUG === 'true' ? { debug: true } : {}),
  });

  logger.info(
    {
      smtpHost: config.email.host,
      smtpPort: config.email.port,
      forceIpv4: config.email.forceIpv4,
      connectionTimeoutMs: config.email.connectionTimeoutMs,
    },
    'SMTP transporter created',
  );

  return transporter;
}

export async function sendHtmlEmail(to: string, subject: string, html: string, text: string): Promise<EmailSendResult> {
  const transport = getTransporter();
  if (!transport) {
    logger.warn({ to, subject }, 'Email skipped — set SMTP_USER and SMTP_PASS on the API host (e.g. Render)');
    return { ok: false, reason: 'no_transport' };
  }

  try {
    const info = await transport.sendMail({
      from: config.email.from,
      to,
      subject,
      text,
      html,
    });
    const messageId = typeof info?.messageId === 'string' ? info.messageId : undefined;
    logger.info({ to, subject, messageId, from: config.email.from }, 'Email accepted by SMTP');
    return { ok: true, messageId };
  } catch (err) {
    const detail = smtpFailureDetail(err);
    logger.error({ err, to, subject, from: config.email.from, detail }, 'SMTP rejected or failed send');
    return { ok: false, reason: 'smtp_error', detail };
  }
}
