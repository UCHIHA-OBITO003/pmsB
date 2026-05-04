-- CreateTable
CREATE TABLE "sheet_sync_configs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sheetId" TEXT NOT NULL,
    "sheetUrl" TEXT NOT NULL,
    "sheetName" TEXT,
    "columnMapping" JSONB NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "intervalMins" INTEGER NOT NULL DEFAULT 30,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncStats" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sheet_sync_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sheet_sync_configs_projectId_sheetId_key" ON "sheet_sync_configs"("projectId", "sheetId");

-- AddForeignKey
ALTER TABLE "sheet_sync_configs" ADD CONSTRAINT "sheet_sync_configs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
