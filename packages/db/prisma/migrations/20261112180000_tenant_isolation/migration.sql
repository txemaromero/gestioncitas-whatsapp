-- F19: tenant isolation enforced by PostgreSQL. The application connects as `clinicai_app`
-- (no BYPASSRLS, not the table owner): every row it reads or writes must belong to the clinic set
-- for the current transaction with `set_config('app.tenant_id', <uuid>, true)`. Without it, it sees
-- nothing. Work that spans clinics (queue, tenant lookup by phone number, jobs, onboarding) uses the
-- owner connection, which is not subject to these policies.
--
-- The role has no password here (no secrets in migrations): give it one when deploying,
--   ALTER ROLE clinicai_app WITH LOGIN PASSWORD '…';
-- and point DATABASE_APP_URL at it (see docs/deploy.md).

DO $$
BEGIN
  CREATE ROLE clinicai_app NOLOGIN;
EXCEPTION
  -- Roles are cluster-wide: it may exist already (another database, or created concurrently).
  WHEN duplicate_object OR unique_violation THEN NULL;
END
$$;

-- Clinic of the current transaction, or NULL (after a transaction a custom setting reads as '').
CREATE FUNCTION clinicai_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

GRANT USAGE ON SCHEMA public TO clinicai_app;
GRANT EXECUTE ON FUNCTION clinicai_current_tenant() TO clinicai_app;

-- Only what the application needs. No default privileges on purpose: a new table is not visible to
-- the application until a migration grants it and adds its policy (fails closed).
GRANT SELECT, UPDATE ON TABLE "tenant_config" TO clinicai_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "tenant_members", "tenant_invitations", "clients", "employees", "services", "time_off", "appointments",
  "conversation_state", "bot_blacklist", "chatwoot_links", "inbound_events", "waitlist_entries"
TO clinicai_app;
GRANT USAGE, SELECT ON SEQUENCE "inbound_events_id_seq" TO clinicai_app;

CREATE POLICY "tenant_isolation" ON "tenant_config" TO clinicai_app
  USING ("id" = clinicai_current_tenant()) WITH CHECK ("id" = clinicai_current_tenant());

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'tenant_members', 'tenant_invitations', 'clients', 'employees', 'services', 'time_off', 'appointments',
    'conversation_state', 'bot_blacklist', 'chatwoot_links', 'inbound_events', 'waitlist_entries'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY "tenant_isolation" ON public.%I TO clinicai_app '
      'USING ("tenant_id" = clinicai_current_tenant()) WITH CHECK ("tenant_id" = clinicai_current_tenant())',
      tbl
    );
  END LOOP;
END
$$;
