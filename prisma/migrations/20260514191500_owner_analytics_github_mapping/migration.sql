CREATE TYPE "OwnerAnalyticsCadence" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM');

ALTER TYPE "EmailEventType" ADD VALUE IF NOT EXISTS 'OWNER_ANALYTICS_REPORT';

ALTER TABLE "user_email_preferences"
ADD COLUMN "ownerAnalyticsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "ownerAnalyticsCadence" "OwnerAnalyticsCadence" NOT NULL DEFAULT 'DAILY',
ADD COLUMN "ownerAnalyticsLookbackDays" INTEGER,
ADD COLUMN "lastOwnerAnalyticsSentAt" TIMESTAMP(3);
