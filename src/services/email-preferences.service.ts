import type { EmailEventType, UserEmailPreference } from '@prisma/client';
import { prisma } from '../utils/prisma';

type PreferenceSnapshot = Pick<
  UserEmailPreference,
  | 'transactionalEnabled'
  | 'securityEnabled'
  | 'ticketInstantEnabled'
  | 'commentInstantEnabled'
  | 'digestEnabled'
  | 'ownerAnalyticsEnabled'
  | 'ownerAnalyticsCadence'
  | 'ownerAnalyticsLookbackDays'
  | 'lastDigestAt'
  | 'lastOwnerAnalyticsSentAt'
>;

const DEFAULTS: PreferenceSnapshot = {
  transactionalEnabled: true,
  securityEnabled: true,
  ticketInstantEnabled: true,
  commentInstantEnabled: true,
  digestEnabled: true,
  ownerAnalyticsEnabled: false,
  ownerAnalyticsCadence: 'DAILY',
  ownerAnalyticsLookbackDays: null,
  lastDigestAt: null,
  lastOwnerAnalyticsSentAt: null,
};

export async function getUserEmailPreferences(userId: string): Promise<PreferenceSnapshot> {
  const row = await prisma.userEmailPreference.findUnique({
    where: { userId },
    select: {
      transactionalEnabled: true,
      securityEnabled: true,
      ticketInstantEnabled: true,
      commentInstantEnabled: true,
      digestEnabled: true,
      ownerAnalyticsEnabled: true,
      ownerAnalyticsCadence: true,
      ownerAnalyticsLookbackDays: true,
      lastDigestAt: true,
      lastOwnerAnalyticsSentAt: true,
    },
  });

  return row ?? DEFAULTS;
}

export async function markDigestSent(userId: string, at = new Date()): Promise<void> {
  await prisma.userEmailPreference.upsert({
    where: { userId },
    create: { userId, lastDigestAt: at },
    update: { lastDigestAt: at },
  });
}

export async function markOwnerAnalyticsSent(userId: string, at = new Date()): Promise<void> {
  await prisma.userEmailPreference.upsert({
    where: { userId },
    create: { userId, lastOwnerAnalyticsSentAt: at },
    update: { lastOwnerAnalyticsSentAt: at },
  });
}

export async function shouldSendEmailEvent(userId: string | undefined, eventType: EmailEventType): Promise<boolean> {
  if (!userId) return true;
  const prefs = await getUserEmailPreferences(userId);

  switch (eventType) {
    case 'PASSWORD_RESET_OTP':
      return prefs.securityEnabled;
    case 'USER_WELCOME':
    case 'USER_PROFILE_UPDATED':
      return prefs.transactionalEnabled;
    case 'TICKET_COMMENTED':
      return prefs.commentInstantEnabled;
    case 'TICKET_DIGEST_DAILY':
      return prefs.digestEnabled;
    case 'OWNER_ANALYTICS_REPORT':
      return prefs.ownerAnalyticsEnabled;
    default:
      return prefs.ticketInstantEnabled;
  }
}
