-- AddForeignKey
ALTER TABLE "workload_snapshots" ADD CONSTRAINT "workload_snapshots_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
