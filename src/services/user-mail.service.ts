import { enqueueTransactionalEmail, type QueueEmailResult } from './email-dispatch.service';
import { buildAdminProfileUpdatedEmail, buildWelcomeCredentialsEmail } from './email-templates/user-email.templates';

export async function sendWelcomeCredentialsEmail(params: {
  userId?: string;
  to: string;
  firstName: string;
  email: string;
  temporaryPassword: string;
}): Promise<QueueEmailResult> {
  const template = buildWelcomeCredentialsEmail({
    firstName: params.firstName,
    email: params.email,
    temporaryPassword: params.temporaryPassword,
  });
  return enqueueTransactionalEmail({
    userId: params.userId,
    to: params.to,
    template,
    eventType: 'USER_WELCOME',
    resourceType: 'user',
    resourceId: params.userId,
  });
}

export async function sendAdminProfileNotificationEmail(params: {
  userId?: string;
  to: string;
  firstName: string;
  lines: string[];
  plainPasswordSent?: boolean;
  newPasswordPlain?: string;
}): Promise<QueueEmailResult> {
  const template = buildAdminProfileUpdatedEmail({
    firstName: params.firstName,
    email: params.to,
    lines: params.lines,
    newPasswordPlain: params.newPasswordPlain,
    passwordChanged: params.plainPasswordSent,
  });
  return enqueueTransactionalEmail({
    userId: params.userId,
    to: params.to,
    template,
    eventType: 'USER_PROFILE_UPDATED',
    resourceType: 'user',
    resourceId: params.userId,
  });
}
