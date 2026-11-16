-- F18: professional role (panel users that only see their own employee) and team invitations.
-- AlterEnum
ALTER TYPE "member_role" ADD VALUE 'professional';

-- AlterTable
ALTER TABLE "tenant_members" ADD COLUMN     "employee_id" UUID;

-- CreateTable
CREATE TABLE "tenant_invitations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "member_role" NOT NULL,
    "employee_id" UUID,
    "invited_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_invitations_email_idx" ON "tenant_invitations"("email");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_invitations_tenant_id_email_key" ON "tenant_invitations"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_invitations_tenant_id_employee_id_key" ON "tenant_invitations"("tenant_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_members_tenant_id_employee_id_key" ON "tenant_members"("tenant_id", "employee_id");

-- AddForeignKey
ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Not expressible in the Prisma schema. The role is compared as text: a value added to an enum
-- cannot be used as such in the same transaction.
ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_professional_employee"
  CHECK (("role"::text = 'professional') = ("employee_id" IS NOT NULL));
ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_professional_employee"
  CHECK (("role"::text = 'professional') = ("employee_id" IS NOT NULL));
ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_not_owner" CHECK ("role"::text <> 'owner');
ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_lower_email" CHECK ("email" = lower("email"));

-- Defense in depth, same as 20261110144500_enable_rls: Supabase API roles get nothing.
ALTER TABLE "tenant_invitations" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.tenant_invitations FROM %I', api_role);
      EXECUTE format(
        'CREATE POLICY %I ON public.tenant_invitations AS RESTRICTIVE FOR ALL TO %I USING (false) WITH CHECK (false)',
        'deny_' || api_role || '_tenant_invitations', api_role
      );
    END IF;
  END LOOP;
END
$$;
