-- F14: services with their own duration, time off (absences and clinic closures), appointment service.
-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "service_id" UUID;

-- CreateTable
CREATE TABLE "services" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_off" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "time_off_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "services_tenant_id_id_key" ON "services"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "services_tenant_id_name_key" ON "services"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "time_off_tenant_id_starts_at_idx" ON "time_off"("tenant_id", "starts_at");

-- CreateIndex
CREATE INDEX "time_off_tenant_id_employee_id_idx" ON "time_off"("tenant_id", "employee_id");

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tenant_id_service_id_fkey" FOREIGN KEY ("tenant_id", "service_id") REFERENCES "services"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- Invariants Prisma cannot express.
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_valid_range" CHECK ("ends_at" > "starts_at");
ALTER TABLE "services" ADD CONSTRAINT "services_valid_duration" CHECK ("duration_minutes" BETWEEN 10 AND 480);

-- Defense in depth, same as 20261110144500_enable_rls: Supabase API roles get nothing.
ALTER TABLE "services" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "time_off" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
  tbl text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      FOREACH tbl IN ARRAY ARRAY['services', 'time_off'] LOOP
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', tbl, api_role);
        EXECUTE format(
          'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO %I USING (false) WITH CHECK (false)',
          'deny_' || api_role || '_' || tbl, tbl, api_role
        );
      END LOOP;
    END IF;
  END LOOP;
END
$$;
