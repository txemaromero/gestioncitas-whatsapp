-- F12 (GDPR): privacy notice acceptance and anonymisation on clients; internal jobs in the queue.
-- CreateEnum
CREATE TYPE "consent_channel" AS ENUM ('whatsapp', 'web');

-- AlterEnum
ALTER TYPE "inbound_event_source" ADD VALUE 'internal';

-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "anonymized_at" TIMESTAMPTZ(6),
ADD COLUMN     "consent_at" TIMESTAMPTZ(6),
ADD COLUMN     "consent_channel" "consent_channel",
ADD COLUMN     "consent_version" TEXT;

