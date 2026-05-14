CREATE TYPE "GitHubAccountType" AS ENUM ('USER', 'ORGANIZATION');
CREATE TYPE "GitHubLinkStatus" AS ENUM ('PENDING', 'ACTIVE', 'DISCONNECTED', 'ERROR');
CREATE TYPE "GitHubSyncStatus" AS ENUM ('IDLE', 'RUNNING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "GitHubIdentitySource" AS ENUM ('MANUAL', 'AUTO', 'EMAIL', 'WEBHOOK');
CREATE TYPE "GitHubEventType" AS ENUM (
  'COMMIT',
  'PULL_REQUEST',
  'ISSUE',
  'ISSUE_COMMENT',
  'REVIEW',
  'CHECK_RUN',
  'PROJECT_ITEM',
  'RELEASE',
  'UNKNOWN'
);

CREATE TABLE "github_installations" (
  "id" TEXT NOT NULL,
  "githubInstallationId" TEXT NOT NULL,
  "accountId" TEXT,
  "accountLogin" TEXT NOT NULL,
  "accountType" "GitHubAccountType" NOT NULL DEFAULT 'ORGANIZATION',
  "appSlug" TEXT,
  "targetType" TEXT,
  "repositorySelection" TEXT,
  "permissions" JSONB,
  "lastWebhookAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "github_installations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "project_github_links" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "installationId" TEXT NOT NULL,
  "ownerLogin" TEXT NOT NULL,
  "ownerType" "GitHubAccountType" NOT NULL DEFAULT 'ORGANIZATION',
  "repositoryId" TEXT NOT NULL,
  "repositoryNodeId" TEXT,
  "repositoryName" TEXT NOT NULL,
  "repositoryFullName" TEXT NOT NULL,
  "defaultBranch" TEXT,
  "githubProjectId" TEXT,
  "githubProjectNumber" INTEGER,
  "githubProjectTitle" TEXT,
  "status" "GitHubLinkStatus" NOT NULL DEFAULT 'PENDING',
  "syncEnabled" BOOLEAN NOT NULL DEFAULT true,
  "lastSyncCursor" TIMESTAMP(3),
  "lastSyncedAt" TIMESTAMP(3),
  "lastSyncStatus" "GitHubSyncStatus" NOT NULL DEFAULT 'IDLE',
  "lastSyncError" TEXT,
  "lastWebhookDeliveredAt" TIMESTAMP(3),
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_github_links_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_github_identities" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "githubUserId" TEXT NOT NULL,
  "login" TEXT NOT NULL,
  "displayName" TEXT,
  "primaryEmail" TEXT,
  "avatarUrl" TEXT,
  "profileUrl" TEXT,
  "source" "GitHubIdentitySource" NOT NULL DEFAULT 'MANUAL',
  "confidence" DOUBLE PRECISION,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_github_identities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "github_activity_events" (
  "id" TEXT NOT NULL,
  "projectGitHubLinkId" TEXT NOT NULL,
  "githubDeliveryId" TEXT,
  "eventType" "GitHubEventType" NOT NULL,
  "action" TEXT NOT NULL DEFAULT '',
  "externalId" TEXT NOT NULL,
  "actorGithubUserId" TEXT,
  "actorLogin" TEXT,
  "actorDisplayName" TEXT,
  "actorEmail" TEXT,
  "branch" TEXT,
  "title" TEXT,
  "body" TEXT,
  "url" TEXT,
  "commitSha" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "mappedUserId" TEXT,
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "github_activity_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "github_daily_summaries" (
  "id" TEXT NOT NULL,
  "projectGitHubLinkId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "commits" INTEGER NOT NULL DEFAULT 0,
  "pullRequestsOpened" INTEGER NOT NULL DEFAULT 0,
  "pullRequestsMerged" INTEGER NOT NULL DEFAULT 0,
  "reviewsSubmitted" INTEGER NOT NULL DEFAULT 0,
  "issuesUpdated" INTEGER NOT NULL DEFAULT 0,
  "checksPassed" INTEGER NOT NULL DEFAULT 0,
  "checksFailed" INTEGER NOT NULL DEFAULT 0,
  "projectItemsMoved" INTEGER NOT NULL DEFAULT 0,
  "summary" TEXT NOT NULL,
  "plannedNext" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "github_daily_summaries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "github_installations_githubInstallationId_key" ON "github_installations"("githubInstallationId");
CREATE INDEX "github_installations_accountLogin_idx" ON "github_installations"("accountLogin");

CREATE UNIQUE INDEX "project_github_links_projectId_key" ON "project_github_links"("projectId");
CREATE INDEX "project_github_links_installationId_idx" ON "project_github_links"("installationId");
CREATE INDEX "project_github_links_repositoryFullName_idx" ON "project_github_links"("repositoryFullName");
CREATE INDEX "project_github_links_status_syncEnabled_idx" ON "project_github_links"("status", "syncEnabled");

CREATE UNIQUE INDEX "user_github_identities_userId_key" ON "user_github_identities"("userId");
CREATE UNIQUE INDEX "user_github_identities_githubUserId_key" ON "user_github_identities"("githubUserId");
CREATE INDEX "user_github_identities_login_idx" ON "user_github_identities"("login");
CREATE INDEX "user_github_identities_primaryEmail_idx" ON "user_github_identities"("primaryEmail");

CREATE UNIQUE INDEX "github_activity_events_projectGitHubLinkId_eventType_externalId_action_key"
ON "github_activity_events"("projectGitHubLinkId", "eventType", "externalId", "action");
CREATE INDEX "github_activity_events_projectGitHubLinkId_occurredAt_idx"
ON "github_activity_events"("projectGitHubLinkId", "occurredAt");
CREATE INDEX "github_activity_events_mappedUserId_occurredAt_idx"
ON "github_activity_events"("mappedUserId", "occurredAt");
CREATE INDEX "github_activity_events_actorLogin_idx" ON "github_activity_events"("actorLogin");

CREATE UNIQUE INDEX "github_daily_summaries_projectGitHubLinkId_userId_date_key"
ON "github_daily_summaries"("projectGitHubLinkId", "userId", "date");
CREATE INDEX "github_daily_summaries_userId_date_idx" ON "github_daily_summaries"("userId", "date");

ALTER TABLE "project_github_links"
ADD CONSTRAINT "project_github_links_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_github_links"
ADD CONSTRAINT "project_github_links_installationId_fkey"
FOREIGN KEY ("installationId") REFERENCES "github_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_github_identities"
ADD CONSTRAINT "user_github_identities_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "github_activity_events"
ADD CONSTRAINT "github_activity_events_projectGitHubLinkId_fkey"
FOREIGN KEY ("projectGitHubLinkId") REFERENCES "project_github_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "github_activity_events"
ADD CONSTRAINT "github_activity_events_mappedUserId_fkey"
FOREIGN KEY ("mappedUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "github_daily_summaries"
ADD CONSTRAINT "github_daily_summaries_projectGitHubLinkId_fkey"
FOREIGN KEY ("projectGitHubLinkId") REFERENCES "project_github_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "github_daily_summaries"
ADD CONSTRAINT "github_daily_summaries_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
