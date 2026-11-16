-- F30: optional second reminder the same day, a few hours before the appointment.
-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "second_reminder_sent_at" TIMESTAMPTZ(6);
