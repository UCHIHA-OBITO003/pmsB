/*
  Warnings:

  - You are about to drop the column `assigneeId` on the `tickets` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_assigneeId_fkey";

-- DropIndex
DROP INDEX "tickets_assigneeId_idx";

-- AlterTable
ALTER TABLE "tickets" DROP COLUMN "assigneeId";

-- CreateTable
CREATE TABLE "_TicketAssignees" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "_TicketAssignees_AB_unique" ON "_TicketAssignees"("A", "B");

-- CreateIndex
CREATE INDEX "_TicketAssignees_B_index" ON "_TicketAssignees"("B");

-- AddForeignKey
ALTER TABLE "_TicketAssignees" ADD CONSTRAINT "_TicketAssignees_A_fkey" FOREIGN KEY ("A") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_TicketAssignees" ADD CONSTRAINT "_TicketAssignees_B_fkey" FOREIGN KEY ("B") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
