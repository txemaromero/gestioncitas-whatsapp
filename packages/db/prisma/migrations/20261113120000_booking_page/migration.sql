-- F27: address of the public booking page of each clinic (`/reservar/<slug>`).
-- AlterTable
ALTER TABLE "tenant_config" ADD COLUMN     "public_slug" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "tenant_config_public_slug_key" ON "tenant_config"("public_slug");
