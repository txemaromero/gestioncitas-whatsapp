-- Defense in depth (spec 3.2). The app connects through Prisma with the table-owner role,
-- which is not subject to RLS (never use FORCE ROW LEVEL SECURITY here). Tenant isolation
-- is enforced by the application (tenant-scoped repositories + tRPC protectedProcedure).
-- These statements make sure Supabase's REST API (roles anon / authenticated) cannot read
-- or write any table: RLS enabled with no permissive policy denies everything.

ALTER TABLE "tenant_config"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_members"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clients"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employees"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointments"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversation_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bot_blacklist"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "processed_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chatwoot_links"     ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
  tbl text;
BEGIN
  -- Prisma's own bookkeeping table is also exposed by Supabase's API when present.
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public._prisma_migrations ENABLE ROW LEVEL SECURITY';
  END IF;

  -- Supabase-only roles: skipped on plain PostgreSQL (local / CI).
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      FOREACH tbl IN ARRAY ARRAY[
        'tenant_config', 'tenant_members', 'clients', 'employees', 'appointments',
        'conversation_state', 'bot_blacklist', 'processed_messages', 'chatwoot_links'
      ] LOOP
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', tbl, api_role);
        EXECUTE format(
          'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO %I USING (false) WITH CHECK (false)',
          'deny_' || api_role || '_' || tbl, tbl, api_role
        );
      END LOOP;
    END IF;
  END LOOP;
END $$;
