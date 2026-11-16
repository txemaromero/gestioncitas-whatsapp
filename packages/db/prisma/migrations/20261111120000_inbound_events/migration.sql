-- F11: durable inbox for webhook events. Replaces `processed_messages` (idempotency now comes
-- from the unique (source, external_id) of `inbound_events`).

-- CreateEnum
CREATE TYPE "inbound_event_source" AS ENUM ('whatsapp', 'chatwoot');

-- CreateEnum
CREATE TYPE "inbound_event_status" AS ENUM ('pending', 'processing', 'done', 'failed');

-- CreateTable
CREATE TABLE "inbound_events" (
    "id" BIGSERIAL NOT NULL,
    "source" "inbound_event_source" NOT NULL,
    "external_id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "inbound_event_status" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "inbound_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inbound_events_status_available_at_idx" ON "inbound_events"("status", "available_at");

-- CreateIndex
CREATE INDEX "inbound_events_tenant_id_phone_id_idx" ON "inbound_events"("tenant_id", "phone", "id");

-- CreateIndex
CREATE INDEX "inbound_events_finished_at_idx" ON "inbound_events"("finished_at");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_events_source_external_id_key" ON "inbound_events"("source", "external_id");

-- AddForeignKey
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Keep idempotency across the deploy: messages already processed become `done` events, so a
-- late Meta retry of one of them is still ignored. Phone is unknown (done events never block).
INSERT INTO "inbound_events" ("source", "external_id", "tenant_id", "phone", "payload", "status", "attempts", "received_at", "finished_at")
SELECT 'whatsapp', pm."wa_message_id", pm."tenant_id", '', '{}'::jsonb, 'done', 1, pm."processed_at", pm."processed_at"
FROM "processed_messages" pm
WHERE EXISTS (SELECT 1 FROM "tenant_config" t WHERE t."id" = pm."tenant_id")
ON CONFLICT DO NOTHING;

-- DropTable
DROP TABLE "processed_messages";

-- Defense in depth, same as 20261110144500_enable_rls: Supabase API roles get nothing.
ALTER TABLE "inbound_events" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.inbound_events FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON SEQUENCE public.inbound_events_id_seq FROM %I', api_role);
      EXECUTE format(
        'CREATE POLICY %I ON public.inbound_events AS RESTRICTIVE FOR ALL TO %I USING (false) WITH CHECK (false)',
        'deny_' || api_role || '_inbound_events', api_role
      );
    END IF;
  END LOOP;
END
$$;
