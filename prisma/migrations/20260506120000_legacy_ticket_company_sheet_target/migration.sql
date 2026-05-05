-- AlterTable
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "legacySourceKey" TEXT;
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "companyId" TEXT;

-- CreateIndex (partial unique — allow multiple NULL legacy keys)
CREATE UNIQUE INDEX IF NOT EXISTS "tickets_legacySourceKey_key" ON "tickets"("legacySourceKey") WHERE "legacySourceKey" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "tickets_companyId_idx" ON "tickets"("companyId");

-- AddForeignKey
ALTER TABLE "tickets" DROP CONSTRAINT IF EXISTS "tickets_companyId_fkey";
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "sheet_sync_configs" ADD COLUMN IF NOT EXISTS "legacyTicketProjectId" TEXT;

ALTER TABLE "sheet_sync_configs" DROP CONSTRAINT IF EXISTS "sheet_sync_configs_legacyTicketProjectId_fkey";
ALTER TABLE "sheet_sync_configs" ADD CONSTRAINT "sheet_sync_configs_legacyTicketProjectId_fkey" FOREIGN KEY ("legacyTicketProjectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "legacyIssueNumber" INTEGER;

CREATE INDEX IF NOT EXISTS "tickets_legacyIssueNumber_idx" ON "tickets"("legacyIssueNumber");
