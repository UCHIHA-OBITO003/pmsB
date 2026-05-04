-- Create external sync jobs table if missing
CREATE TABLE IF NOT EXISTS "external_sync_jobs" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "startId" INTEGER NOT NULL,
  "endId" INTEGER NOT NULL,
  "currentId" INTEGER NOT NULL,
  "totalCount" INTEGER NOT NULL,
  "successCount" INTEGER NOT NULL DEFAULT 0,
  "failCount" INTEGER NOT NULL DEFAULT 0,
  "skippedCount" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "error" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "external_sync_jobs_pkey" PRIMARY KEY ("id")
);

-- Ensure project FK exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints tc
    WHERE tc.constraint_name = 'external_sync_jobs_projectId_fkey'
      AND tc.table_name = 'external_sync_jobs'
  ) THEN
    ALTER TABLE "external_sync_jobs"
      ADD CONSTRAINT "external_sync_jobs_projectId_fkey"
      FOREIGN KEY ("projectId")
      REFERENCES "projects"("id")
      ON DELETE RESTRICT
      ON UPDATE CASCADE;
  END IF;
END $$;

-- Add ticket link column if missing
ALTER TABLE "tickets"
  ADD COLUMN IF NOT EXISTS "syncJobId" TEXT;

-- Index for relation lookups
CREATE INDEX IF NOT EXISTS "tickets_syncJobId_idx" ON "tickets"("syncJobId");

-- Ensure ticket -> external sync job FK exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints tc
    WHERE tc.constraint_name = 'tickets_syncJobId_fkey'
      AND tc.table_name = 'tickets'
  ) THEN
    ALTER TABLE "tickets"
      ADD CONSTRAINT "tickets_syncJobId_fkey"
      FOREIGN KEY ("syncJobId")
      REFERENCES "external_sync_jobs"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;
END $$;
