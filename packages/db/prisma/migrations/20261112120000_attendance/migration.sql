-- F15: attendance of past appointments (attended / no_show), marked by the staff.
-- CreateEnum
CREATE TYPE "attendance" AS ENUM ('attended', 'no_show');

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "attendance" "attendance",
ADD COLUMN     "attendance_marked_at" TIMESTAMPTZ(6);

