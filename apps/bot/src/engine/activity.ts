/**
 * F24: entries of the activity log for what clients do through WhatsApp. Same rules as the panel:
 * ids and safe details only (never the client's messages, name or phone). Never fails the action.
 */
import { logActivity } from '@clinicai/db';
import { maskPhone, safeActivityDetails } from '@clinicai/shared';
import type { FlowContext } from './flow';

export async function recordWhatsApp(
  ctx: FlowContext,
  action: string,
  data: { entityType?: string; entityId?: string | null; clientId?: string | null; details?: Record<string, unknown> } = {},
): Promise<void> {
  try {
    await logActivity(ctx.deps.db, ctx.tenant.id, {
      actorType: 'whatsapp',
      actorLabel: 'WhatsApp',
      action,
      entityType: data.entityType ?? null,
      entityId: data.entityId ?? null,
      clientId: data.clientId ?? ctx.client?.id ?? null,
      details: safeActivityDetails(data.details),
    });
  } catch (error) {
    ctx.deps.logger.warn(
      { tenantId: ctx.tenant.id, phone: maskPhone(ctx.phone), action, err: error instanceof Error ? error.message : String(error) },
      'activity not logged',
    );
  }
}
