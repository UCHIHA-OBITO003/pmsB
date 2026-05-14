ALTER TABLE "projects"
ADD COLUMN "githubBoardInstallationId" TEXT,
ADD COLUMN "githubBoardOwnerLogin" TEXT,
ADD COLUMN "githubBoardOwnerType" "GitHubAccountType",
ADD COLUMN "githubProjectId" TEXT,
ADD COLUMN "githubProjectNumber" INTEGER,
ADD COLUMN "githubProjectTitle" TEXT;

UPDATE "projects" AS p
SET
  "githubBoardInstallationId" = l."installationId",
  "githubBoardOwnerLogin" = l."ownerLogin",
  "githubBoardOwnerType" = l."ownerType",
  "githubProjectId" = l."githubProjectId",
  "githubProjectNumber" = l."githubProjectNumber",
  "githubProjectTitle" = l."githubProjectTitle"
FROM "project_github_links" AS l
WHERE l."projectId" = p."id";

ALTER TABLE "projects"
ADD CONSTRAINT "projects_githubBoardInstallationId_fkey"
FOREIGN KEY ("githubBoardInstallationId") REFERENCES "github_installations"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "projects_githubBoardInstallationId_idx" ON "projects"("githubBoardInstallationId");
CREATE INDEX "projects_githubProjectId_idx" ON "projects"("githubProjectId");

ALTER TABLE "github_daily_summaries"
ADD COLUMN "projectId" TEXT;

UPDATE "github_daily_summaries" AS s
SET "projectId" = l."projectId"
FROM "project_github_links" AS l
WHERE l."id" = s."projectGitHubLinkId";

ALTER TABLE "github_daily_summaries"
ALTER COLUMN "projectId" SET NOT NULL;

ALTER TABLE "github_daily_summaries"
DROP CONSTRAINT "github_daily_summaries_projectGitHubLinkId_fkey";

DROP INDEX "github_daily_summaries_projectGitHubLinkId_userId_date_key";

ALTER TABLE "github_daily_summaries"
ADD CONSTRAINT "github_daily_summaries_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "projects"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "github_daily_summaries_projectId_userId_date_key"
ON "github_daily_summaries"("projectId", "userId", "date");

CREATE INDEX "github_daily_summaries_projectId_date_idx"
ON "github_daily_summaries"("projectId", "date");

ALTER TABLE "github_daily_summaries"
DROP COLUMN "projectGitHubLinkId";

DROP INDEX "project_github_links_projectId_key";

CREATE UNIQUE INDEX "project_github_links_projectId_repositoryId_key"
ON "project_github_links"("projectId", "repositoryId");

CREATE INDEX "project_github_links_projectId_idx"
ON "project_github_links"("projectId");

ALTER TABLE "project_github_links"
DROP COLUMN "githubProjectId",
DROP COLUMN "githubProjectNumber",
DROP COLUMN "githubProjectTitle";
