-- AlterTable
ALTER TABLE "Projects" ADD COLUMN     "DateOverwriteAllowed" TIMESTAMP(6),
ADD COLUMN     "OverwriteAllowedById" INTEGER;

-- CreateIndex
CREATE INDEX "IX_Projects_OverwriteAllowedById" ON "Projects"("OverwriteAllowedById");

-- AddForeignKey
ALTER TABLE "Projects" ADD CONSTRAINT "FK_Projects_Users_OverwriteAllowedById" FOREIGN KEY ("OverwriteAllowedById") REFERENCES "Users"("Id") ON DELETE SET NULL ON UPDATE NO ACTION;

