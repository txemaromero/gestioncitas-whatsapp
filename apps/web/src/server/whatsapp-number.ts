/**
 * F32: before a clinic stores a WhatsApp `phone_number_id`, Meta must confirm that the clinic's own
 * token reaches it (`GET /{phone_number_id}`). Incoming messages are routed to a clinic by that id
 * alone, so without this check a clinic could take another one's number and receive its patients'
 * messages. With WHATSAPP_MODE=mock (development) nothing is asked to Meta.
 */
export const DEFAULT_GRAPH_VERSION = 'v27.0';
const GRAPH_VERSION_PATTERN = /^v\d+\.\d+$/;
/** Graph API errors: 190 = invalid or expired token; 100/803 = unknown object or no permission. */
const TOKEN_ERROR = 190;

export type WhatsAppNumberCheck = { ok: true; displayPhone: string | null } | { ok: false; message: string };

export async function verifyWhatsAppNumber(
  input: { phoneNumberId: string; accessToken: string },
  options: { fetchFn?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<WhatsAppNumberCheck> {
  const env = options.env ?? process.env;
  if (env.WHATSAPP_MODE === 'mock') return { ok: true, displayPhone: null };
  const version = env.META_GRAPH_VERSION && GRAPH_VERSION_PATTERN.test(env.META_GRAPH_VERSION) ? env.META_GRAPH_VERSION : DEFAULT_GRAPH_VERSION;
  const url = `https://graph.facebook.com/${version}/${encodeURIComponent(input.phoneNumberId)}?fields=display_phone_number`;
  let response: Response;
  try {
    response = await (options.fetchFn ?? fetch)(url, {
      headers: { authorization: `Bearer ${input.accessToken}` },
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
  } catch {
    return { ok: false, message: 'No se ha podido comprobar el número con Meta. Inténtalo de nuevo en unos minutos.' };
  }
  const body = (await response.json().catch(() => ({}))) as { display_phone_number?: unknown; error?: { code?: number } };
  if (response.ok) {
    return { ok: true, displayPhone: typeof body.display_phone_number === 'string' ? body.display_phone_number : null };
  }
  if (response.status >= 500 || response.status === 429) {
    return { ok: false, message: 'Meta no responde ahora mismo: no se ha podido comprobar el número. Inténtalo de nuevo en unos minutos.' };
  }
  if (body.error?.code === TOKEN_ERROR) {
    return { ok: false, message: 'Meta no acepta el token de acceso: comprueba que es correcto y no ha caducado.' };
  }
  return { ok: false, message: 'Meta no reconoce ese phone_number_id con este token: comprueba que el número es de tu cuenta de WhatsApp Business.' };
}
