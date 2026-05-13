ALTER TABLE "workflow_states"
ADD COLUMN IF NOT EXISTS "wipLimit" INTEGER;

ALTER TABLE "tickets"
ADD COLUMN IF NOT EXISTS "boardOrder" DOUBLE PRECISION NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT
    t."id",
    ROW_NUMBER() OVER (
      PARTITION BY t."projectId", t."workflowStateId"
      ORDER BY t."createdAt" ASC, t."id" ASC
    ) * 1024 AS next_order
  FROM "tickets" t
  WHERE t."deletedAt" IS NULL
)
UPDATE "tickets" t
SET "boardOrder" = ranked.next_order
FROM ranked
WHERE t."id" = ranked."id"
  AND (t."boardOrder" IS NULL OR t."boardOrder" = 0);

CREATE INDEX IF NOT EXISTS "tickets_projectId_workflowStateId_boardOrder_idx"
ON "tickets" ("projectId", "workflowStateId", "boardOrder");
