-- F24: activity log (who did what), append-only for the application role.
-- CreateEnum
CREATE TYPE "activity_actor" AS ENUM ('member', 'whatsapp', 'system');

-- CreateTable
CREATE TABLE "activity_log" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_type" "activity_actor" NOT NULL,
    "actor_member_id" UUID,
    "actor_label" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "client_id" UUID,
    "details" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "activity_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "activity_log_tenant_id_id_idx" ON "activity_log"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "activity_log_tenant_id_client_id_idx" ON "activity_log"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "activity_log_created_at_idx" ON "activity_log"("created_at");

-- AddForeignKey
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Defense in depth, same as 20261110144500_enable_rls: Supabase API roles get nothing.
ALTER TABLE "activity_log" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.activity_log FROM %I', api_role);
      EXECUTE format(
        'CREATE POLICY %I ON public.activity_log AS RESTRICTIVE FOR ALL TO %I USING (false) WITH CHECK (false)',
        'deny_' || api_role || '_activity_log', api_role
      );
    END IF;
  END LOOP;
END
$$;

-- F19 application role: it can read and add entries of its clinic, and only clear `client_id`
-- (erasure / anonymisation of a client). It can never change or delete an entry; the retention
-- purge runs with the owner connection.
GRANT SELECT, INSERT ON TABLE "activity_log" TO clinicai_app;
GRANT UPDATE ("client_id") ON TABLE "activity_log" TO clinicai_app;
GRANT USAGE, SELECT ON SEQUENCE "activity_log_id_seq" TO clinicai_app;
CREATE POLICY "tenant_isolation" ON "activity_log" TO clinicai_app
  USING ("tenant_id" = clinicai_current_tenant()) WITH CHECK ("tenant_id" = clinicai_current_tenant());
