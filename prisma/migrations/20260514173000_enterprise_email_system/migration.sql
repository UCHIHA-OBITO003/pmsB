CREATE TABLE "user_email_preferences" (
  "userId" TEXT NOT NULL,
  "transactionalEnabled" BOOLEAN NOT NULL DEFAULT true,
  "securityEnabled" BOOLEAN NOT NULL DEFAULT true,
  "ticketInstantEnabled" BOOLEAN NOT NULL DEFAULT true,
  "commentInstantEnabled" BOOLEAN NOT NULL DEFAULT true,
  "digestEnabled" BOOLEAN NOT NULL DEFAULT true,
  "lastDigestAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_email_preferences_pkey" PRIMARY KEY ("userId")
);

CREATE TYPE "EmailDeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'SKIPPED');
CREATE TYPE "EmailEventType" AS ENUM (
  'PASSWORD_RESET_OTP',
  'USER_WELCOME',
  'USER_PROFILE_UPDATED',
  'TICKET_CREATED',
  'TICKET_ASSIGNED',
  'TICKET_UNASSIGNED',
  'TICKET_UPDATED',
  'TICKET_COMMENTED',
  'TICKET_COMPLETED',
  'TICKET_REOPENED',
  'TICKET_DIGEST_DAILY'
);

CREATE TABLE "email_deliveries" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "to" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "templateKey" TEXT NOT NULL,
  "eventType" "EmailEventType" NOT NULL,
  "status" "EmailDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
  "channel" TEXT NOT NULL DEFAULT 'smtp',
  "messageId" TEXT,
  "errorDetail" TEXT,
  "fingerprint" TEXT,
  "resourceType" TEXT,
  "resourceId" TEXT,
  "metadata" JSONB,
  "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "email_deliveries_userId_eventType_queuedAt_idx" ON "email_deliveries"("userId", "eventType", "queuedAt");
CREATE INDEX "email_deliveries_status_queuedAt_idx" ON "email_deliveries"("status", "queuedAt");
CREATE INDEX "email_deliveries_resourceType_resourceId_idx" ON "email_deliveries"("resourceType", "resourceId");
CREATE INDEX "email_deliveries_fingerprint_idx" ON "email_deliveries"("fingerprint");

ALTER TABLE "user_email_preferences"
ADD CONSTRAINT "user_email_preferences_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "email_deliveries"
ADD CONSTRAINT "email_deliveries_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
