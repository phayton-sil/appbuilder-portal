-- AlterTable
ALTER TABLE "Projects" ADD COLUMN     "CheckedOutById" INTEGER,
ADD COLUMN     "DateCheckedOut" TIMESTAMP(6);

-- CreateIndex
CREATE INDEX "IX_Projects_CheckedOutById" ON "Projects"("CheckedOutById");

-- AddForeignKey
ALTER TABLE "Projects" ADD CONSTRAINT "FK_Projects_Users_CheckedOutById" FOREIGN KEY ("CheckedOutById") REFERENCES "Users"("Id") ON DELETE SET NULL ON UPDATE NO ACTION;

