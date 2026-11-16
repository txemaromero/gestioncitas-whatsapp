-- F26: treatments (series of appointments) and session packs (bonos).
-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "pack_id" UUID,
ADD COLUMN     "series_id" UUID;

-- CreateTable
CREATE TABLE "client_packs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "service_id" UUID,
    "name" TEXT NOT NULL,
    "total_sessions" INTEGER NOT NULL,
    "expires_on" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_packs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "client_packs_tenant_id_client_id_idx" ON "client_packs"("tenant_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_packs_tenant_id_id_key" ON "client_packs"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "client_packs_tenant_id_client_id_id_key" ON "client_packs"("tenant_id", "client_id", "id");

-- CreateIndex
CREATE INDEX "appointments_tenant_id_series_id_idx" ON "appointments"("tenant_id", "series_id");

-- CreateIndex
CREATE INDEX "appointments_pack_id_idx" ON "appointments"("pack_id");

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tenant_id_client_id_pack_id_fkey" FOREIGN KEY ("tenant_id", "client_id", "pack_id") REFERENCES "client_packs"("tenant_id", "client_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_packs" ADD CONSTRAINT "client_packs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_packs" ADD CONSTRAINT "client_packs_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "clients"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_packs" ADD CONSTRAINT "client_packs_tenant_id_service_id_fkey" FOREIGN KEY ("tenant_id", "service_id") REFERENCES "services"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- A pack has at least one session.
ALTER TABLE "client_packs" ADD CONSTRAINT "client_packs_total_sessions_check" CHECK ("total_sessions" > 0);

-- Defense in depth, same as 20261110144500_enable_rls: Supabase API roles get nothing.
ALTER TABLE "client_packs" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.client_packs FROM %I', api_role);
      EXECUTE format(
        'CREATE POLICY %I ON public.client_packs AS RESTRICTIVE FOR ALL TO %I USING (false) WITH CHECK (false)',
        'deny_' || api_role || '_client_packs', api_role
      );
    END IF;
  END LOOP;
END
$$;

-- F19 application role: only the packs of the clinic of the request.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "client_packs" TO clinicai_app;
CREATE POLICY "tenant_isolation" ON "client_packs" TO clinicai_app
  USING ("tenant_id" = clinicai_current_tenant()) WITH CHECK ("tenant_id" = clinicai_current_tenant());
