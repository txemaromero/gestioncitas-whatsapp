-- F28: secret links to subscribe to a professional's agenda (iCalendar, read-only).
-- CreateTable
CREATE TABLE "calendar_feeds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_enc" TEXT NOT NULL,
    "full_names" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6),

    CONSTRAINT "calendar_feeds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "calendar_feeds_token_hash_key" ON "calendar_feeds"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_feeds_tenant_id_employee_id_key" ON "calendar_feeds"("tenant_id", "employee_id");

-- AddForeignKey
ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Defense in depth, same as 20261110144500_enable_rls: Supabase API roles get nothing.
ALTER TABLE "calendar_feeds" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.calendar_feeds FROM %I', api_role);
      EXECUTE format(
        'CREATE POLICY %I ON public.calendar_feeds AS RESTRICTIVE FOR ALL TO %I USING (false) WITH CHECK (false)',
        'deny_' || api_role || '_calendar_feeds', api_role
      );
    END IF;
  END LOOP;
END
$$;

-- F19 application role: only the links of the clinic of the request. The public feed finds a link
-- by its token with the owner connection, then reads the agenda inside that clinic.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "calendar_feeds" TO clinicai_app;
CREATE POLICY "tenant_isolation" ON "calendar_feeds" TO clinicai_app
  USING ("tenant_id" = clinicai_current_tenant()) WITH CHECK ("tenant_id" = clinicai_current_tenant());
