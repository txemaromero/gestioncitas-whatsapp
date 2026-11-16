-- F17: waiting list (one row per client and wanted window, with its current offer).
-- CreateEnum
CREATE TYPE "waitlist_status" AS ENUM ('waiting', 'booked', 'left', 'expired');

-- CreateTable
CREATE TABLE "waitlist_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "service_id" UUID,
    "duration_minutes" INTEGER NOT NULL,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "window_end" TIMESTAMPTZ(6) NOT NULL,
    "whole_day" BOOLEAN NOT NULL DEFAULT false,
    "preferred_start" TIMESTAMPTZ(6) NOT NULL,
    "status" "waitlist_status" NOT NULL DEFAULT 'waiting',
    "offer_start" TIMESTAMPTZ(6),
    "offer_employee_id" UUID,
    "offer_expires_at" TIMESTAMPTZ(6),
    "offered_starts" TIMESTAMPTZ(6)[] DEFAULT ARRAY[]::TIMESTAMPTZ(6)[],
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waitlist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "waitlist_entries_tenant_id_status_created_at_idx" ON "waitlist_entries"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "waitlist_entries_client_id_idx" ON "waitlist_entries"("client_id");

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "clients"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_tenant_id_service_id_fkey" FOREIGN KEY ("tenant_id", "service_id") REFERENCES "services"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Not expressible in the Prisma schema: sanity checks and one waiting entry per client and window.
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_valid_window"
  CHECK ("window_end" >= "window_start" AND "preferred_start" BETWEEN "window_start" AND "window_end");
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_valid_duration" CHECK ("duration_minutes" BETWEEN 10 AND 480);
CREATE UNIQUE INDEX "waitlist_entries_one_waiting_per_window" ON "waitlist_entries"("tenant_id", "client_id", "window_start")
  WHERE "status" = 'waiting';

-- Defense in depth, same as 20261110144500_enable_rls: Supabase API roles get nothing.
ALTER TABLE "waitlist_entries" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.waitlist_entries FROM %I', api_role);
      EXECUTE format(
        'CREATE POLICY %I ON public.waitlist_entries AS RESTRICTIVE FOR ALL TO %I USING (false) WITH CHECK (false)',
        'deny_' || api_role || '_waitlist_entries', api_role
      );
    END IF;
  END LOOP;
END
$$;
