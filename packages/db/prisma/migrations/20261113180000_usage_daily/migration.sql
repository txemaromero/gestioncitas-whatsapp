-- F31: usage counters per clinic and day for the platform console (only numbers).
-- CreateTable
CREATE TABLE "usage_daily" (
    "tenant_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "metric" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT '',
    "amount" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "usage_daily_pkey" PRIMARY KEY ("tenant_id","day","metric","model")
);

-- CreateIndex
CREATE INDEX "usage_daily_day_idx" ON "usage_daily"("day");

-- AddForeignKey
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Platform data: RLS on and no grant to clinicai_app (the clinics never read it); Supabase API
-- roles get nothing either. Only the system (owner) connection writes and reads it.
ALTER TABLE "usage_daily" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.usage_daily FROM %I', api_role);
      EXECUTE format(
        'CREATE POLICY %I ON public.usage_daily AS RESTRICTIVE FOR ALL TO %I USING (false) WITH CHECK (false)',
        'deny_' || api_role || '_usage_daily', api_role
      );
    END IF;
  END LOOP;
END
$$;
